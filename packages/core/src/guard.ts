import type { KeyObject } from "node:crypto";
import { callHash } from "./canonical.js";
import { AuditLog } from "./audit/log.js";
import { MandateError, type Mandate, type ReplayGuard, type StepUpClaims, verifyMandate, verifyStepUp } from "./mandate/index.js";
import { parseDecimal } from "./money.js";
import type { PayPalReader } from "./paypal/types.js";
import { evaluatePolicy, type Decision, type OperationFacts, type Reason, type Reservation, type SqlitePolicyStore } from "./policy/index.js";
import { evaluateTaint, descriptorFor, templateExplanation, type ArgAssessment, type Explainer, type RegistryBook, type TaintTruth } from "./taint/index.js";

export interface GuardDeps {
  policy: SqlitePolicyStore;
  audit: AuditLog;
  replay: ReplayGuard;
  reader: PayPalReader;
  registries: RegistryBook;
  ownerPublicKey: KeyObject;
  stepUpPublicKey: KeyObject;
  /** Optional LLM wording. Called only after the decision is made. */
  explainer?: Explainer;
  now?: () => Date;
}

export interface AuthorizeRequest {
  /** The operation mandate the agent presented (JWS). */
  mandateToken: string;
  tool: string;
  args: Record<string, unknown>;
  /** Present when the owner approved this exact call: a single-use step-up mandate. */
  stepUpToken?: string;
}

export interface Authorization {
  decision: Decision;
  reasons: Reason[];
  explanation: string;
  callHash: string;
  agentId?: string;
  mandate?: Mandate;
  stepUp?: StepUpClaims;
  args: ArgAssessment[];
  facts: OperationFacts;
  /** Held budget for an allowed amount-bearing call. Pass the same object to `complete`. */
  reservation?: Reservation;
  /** The firewall's and the policy's separate verdicts, before they were combined (the backtest re-runs the policy alone). */
  parts?: { taint: Verdict; policy: Verdict };
  /** PayPal's record the call was checked against (capture, order, ...), when one was read. */
  truth?: TaintTruth | null;
}

export interface Verdict {
  decision: Decision;
  reasons: Reason[];
}

/**
 * Deny beats hold beats allow. The firewall's payee message names the capture and buyer, so the policy's version of
 * the same finding is dropped; identical reasons are reported once. Shared by the guard and the backtest's what-if.
 */
export function combineVerdicts(taint: Verdict, policy: Verdict): Verdict {
  const policyReasons = policy.reasons.filter((r) => !(r.code === "payee_not_original_buyer" && taint.reasons.some((t) => t.code === r.code)));
  const reasons = dedupe([...taint.reasons, ...policyReasons]);
  const denied = taint.decision === "deny" || policy.decision === "deny";
  const held = taint.decision === "hold" || policy.decision === "hold";
  return { decision: denied ? "deny" : held ? "hold" : "allow", reasons };
}

/**
 * The whole pipeline for one write call:
 * mandate -> kill switch -> (step-up) -> provenance firewall -> policy -> budget -> audit.
 * Deterministic: the optional explainer runs last and cannot influence the decision.
 */
export class Guard {
  constructor(private readonly d: GuardDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  async authorize(req: AuthorizeRequest): Promise<Authorization> {
    const hash = callHash(req.tool, req.args);
    const base = { callHash: hash, args: [] as ArgAssessment[], facts: {} as OperationFacts };
    const finish = async (a: Omit<Authorization, "explanation" | "callHash" | "args" | "facts"> & Partial<Authorization>): Promise<Authorization> => {
      const full = { ...base, ...a, explanation: "" } as Authorization;
      full.explanation = await this.explain(req.tool, full);
      this.d.audit.append({
        agent: full.agentId ?? "unknown",
        tool: req.tool,
        args: req.args,
        decision: full.decision,
        reasons: full.reasons,
        mandateId: full.mandate?.id,
        ts: this.now(),
      });
      return full;
    };

    // 1. Mandate: signature, nbf/exp.
    let mandate: Mandate;
    try {
      mandate = await verifyMandate(req.mandateToken, this.d.ownerPublicKey, { now: this.now() });
    } catch (e) {
      const code = e instanceof MandateError ? `mandate_${e.code}` : "mandate_invalid";
      return finish({ decision: "deny", reasons: [{ code, message: `The mandate was rejected: ${e instanceof Error ? e.message : String(e)}.` }] });
    }
    const agentId = mandate.agentId;
    const who = { agentId, mandate };

    // 2. Every write tool must be modelled. Unknown tools are refused (fail closed).
    const descriptor = descriptorFor(req.tool);
    if (!descriptor) {
      return finish({ ...who, decision: "deny", reasons: [{ code: "tool_unclassified", message: `Tool "${req.tool}" is not classified by PayLeash, so it is refused.` }] });
    }
    const call = { tool: req.tool, args: req.args };
    const policyCtx = { now: this.now(), store: this.d.policy, amountBearing: descriptor.amountBearing };

    // 3. Kill switch first: no PayPal lookups for a frozen agent.
    if (this.d.policy.freezeState(agentId).frozen) {
      const p = evaluatePolicy(mandate, call, { ...policyCtx, facts: {} });
      return finish({ ...who, decision: p.decision, reasons: p.reasons });
    }

    // 4. Step-up: the owner approved exactly this call. Waives holds, never denies.
    let stepUp: StepUpClaims | undefined;
    if (req.stepUpToken) {
      try {
        stepUp = await verifyStepUp(req.stepUpToken, this.d.stepUpPublicKey, { agentId, tool: req.tool, args: req.args }, this.d.replay, { now: this.now() });
      } catch (e) {
        const code = e instanceof MandateError ? `step_up_${e.code}` : "step_up_invalid";
        return finish({ ...who, decision: "deny", reasons: [{ code, message: `The step-up approval was rejected: ${e instanceof Error ? e.message : String(e)}.` }] });
      }
    }

    // 5. Provenance firewall (async: reads PayPal), then policy (sync) on what PayPal says.
    const taint = await evaluateTaint({ call, descriptor, reader: this.d.reader, registry: this.d.registries.forAgent(agentId) });
    const policy = evaluatePolicy(mandate, call, { ...policyCtx, facts: taint.facts });

    const combined = combineVerdicts(taint, policy);
    let decision: Decision = combined.decision;
    let finalReasons = combined.reasons;
    if (decision === "hold" && stepUp) {
      decision = "allow";
      finalReasons = [...finalReasons, { code: "step_up_approved", message: `The owner approved this call (approval ${stepUp.approvalId}).` }];
    }

    // 6. Reserve budget synchronously after the policy check (no await in between).
    let reservation: Reservation | undefined;
    const amount = taint.facts.amount;
    if (decision === "allow" && amount && descriptor.amountBearing) {
      const cap = mandate.constraints[req.tool]?.dailyTotal;
      const r = this.d.policy.reserve({
        agentId,
        tool: req.tool,
        amount,
        callHash: hash,
        dailyLimitMinor: cap !== undefined ? parseDecimal(cap, amount.currency) : undefined,
        now: this.now(),
      });
      if (r) reservation = r;
      else {
        decision = "deny";
        finalReasons = [...finalReasons, { code: "daily_total_exceeded", message: "The rolling 24h budget was used up by a concurrent call." }];
      }
    }

    return finish({ ...who, decision, reasons: finalReasons, stepUp, args: taint.args, facts: taint.facts, reservation, parts: { taint, policy }, truth: taint.truth });
  }

  /** Call after executing an allowed call: settles the budget and records the PayPal result in the audit log. */
  complete(auth: Authorization, tool: string, args: Record<string, unknown>, outcome: { ok: boolean; resultId?: string; error?: string }): void {
    if (auth.reservation) {
      if (outcome.ok) this.d.policy.commit(auth.reservation, outcome.resultId);
      else this.d.policy.release(auth.reservation);
    }
    this.d.audit.append({
      agent: auth.agentId ?? "unknown",
      tool,
      args,
      decision: outcome.ok ? "executed" : "execution_failed",
      reasons: outcome.ok ? [] : [{ code: "execution_failed", message: (outcome.error ?? "PayPal returned an error").slice(0, 300) }],
      mandateId: auth.mandate?.id,
      paypalResultId: outcome.resultId,
      ts: this.now(),
    });
  }

  private async explain(tool: string, a: Authorization): Promise<string> {
    const input = { tool, decision: a.decision, reasons: a.reasons, args: a.args };
    if (!this.d.explainer || a.decision === "allow") return templateExplanation(input);
    try {
      return await this.d.explainer.explain(input);
    } catch {
      return templateExplanation(input);
    }
  }
}

function dedupe(reasons: Reason[]): Reason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const k = `${r.code}|${r.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
