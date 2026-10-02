import type { KeyObject } from "node:crypto";
import {
  AuditLog,
  Guard,
  RegistryBook,
  SqlitePolicyStore,
  callHash,
  formatMinor,
  buildCallContext,
  groupReasons,
  mintStepUp,
  parseDecimal,
  reasonInfo,
  verifyMandate,
  type Authorization,
  type CallContext,
  type HumanReason,
  type Mandate,
  type PayPalReader,
  type ReasonInfo,
} from "@payleash/core";
import type { Approval } from "./approvals.js";
import { ApprovalStore } from "./approvals.js";
import { interpretResult, type ToolExecutor } from "./executor.js";

export interface ProxyAppDeps {
  guard: Guard;
  policy: SqlitePolicyStore;
  audit: AuditLog;
  approvals: ApprovalStore;
  executor: ToolExecutor;
  registries: RegistryBook;
  reader: PayPalReader;
  ownerPublicKey: KeyObject;
  stepUpPrivateKey: KeyObject;
  approvalTtlMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  /** Called once for each NEW held call (not for an agent's retry of the same call): push / email notifications. */
  onHold?: (held: { approval: Approval; owner: OwnerApprovalView }) => void;
}

export interface Session {
  /** The mandate JWS the agent presented. */
  mandateToken: string;
  mandate: Mandate;
}

export interface CallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Arguments that exist only in PayLeash and are removed before a call reaches PayPal. */
const EXTENSION_ARGS: Record<string, string[]> = { create_refund: ["payee_email"] };
export function forwardArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const drop = EXTENSION_ARGS[tool] ?? [];
  return Object.fromEntries(Object.entries(args).filter(([k]) => !drop.includes(k)));
}

const json = (structured: Record<string, unknown>, isError = false): CallResult => ({
  content: [{ type: "text", text: JSON.stringify(structured) }],
  structuredContent: structured,
  ...(isError ? { isError: true } : {}),
});

export class ApprovalError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ApprovalView {
  status: "pending_approval" | "approving" | "executed" | "failed" | "denied" | "expired";
  approvalId: string;
  tool: string;
  reasons: HumanReason[];
  explanation: string;
  expiresAt: string;
  result?: unknown;
  error?: string;
}

/** What the dashboard shows for one approval. The agent never sees this richer view. */
export interface OwnerApprovalView extends Omit<ApprovalView, "reasons"> {
  agentId: string;
  args: Record<string, unknown>;
  createdAt: string;
  decidedAt?: string;
  reasons: (HumanReason & ReasonInfo)[];
  /** Plain-language summary, PayPal facts and the provenance of each argument. */
  context?: CallContext;
}

const viewStatus = (s: Approval["status"]): ApprovalView["status"] => (s === "pending" ? "pending_approval" : s);

export class ProxyApp {
  constructor(private readonly d: ProxyAppDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }
  private log(line: string) {
    this.d.log?.(line);
  }

  /** Verifies an agent's mandate token (HTTP Authorization header, or env for stdio). */
  async openSession(mandateToken: string): Promise<Session> {
    const mandate = await verifyMandate(mandateToken, this.d.ownerPublicKey, { now: this.now() });
    return { mandateToken, mandate };
  }

  // -------------------------------------------------------------------------
  // Write tools: mandate -> policy -> taint -> execute | hold | deny
  // -------------------------------------------------------------------------

  async handleWrite(session: Session, tool: string, args: Record<string, unknown>): Promise<CallResult> {
    const auth = await this.d.guard.authorize({ mandateToken: session.mandateToken, tool, args });

    if (auth.decision === "deny") {
      this.log(`deny ${session.mandate.agentId} ${tool}: ${[...new Set(auth.reasons.map((r) => r.code))].join(",")}`);
      // People (and agents) see one row per reason code; the audit log keeps every raw reason.
      return json({ status: "denied", reasons: groupReasons(auth.reasons), explanation: auth.explanation }, true);
    }

    if (auth.decision === "hold") {
      const { approval, reused } = this.d.approvals.createOrReuse({
        agentId: session.mandate.agentId,
        tool,
        args,
        callHash: auth.callHash,
        mandateToken: session.mandateToken,
        mandateId: session.mandate.id,
        reasons: auth.reasons,
        explanation: auth.explanation,
        ttlMs: this.d.approvalTtlMs ?? 60 * 60 * 1000,
        context: buildCallContext({ tool, args, assessments: auth.args, facts: auth.facts, truth: auth.truth, now: this.now() }),
      });
      this.log(`hold ${session.mandate.agentId} ${tool} -> ${approval.id}${reused ? " (existing)" : ""}`);
      if (!reused) {
        try {
          this.d.onHold?.({ approval, owner: this.ownerView(approval) });
        } catch (e) {
          this.log(`notification failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return json({ status: "pending_approval", approvalId: approval.id, reasons: groupReasons(auth.reasons), explanation: auth.explanation });
    }

    const { outcome: _outcome, ...result } = await this.execute(auth, tool, args);
    return result;
  }

  private async execute(auth: Authorization, tool: string, args: Record<string, unknown>): Promise<CallResult & { outcome: ReturnType<typeof interpretResult> }> {
    let text: string;
    try {
      text = await this.d.executor.run(tool, forwardArgs(tool, args));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.d.guard.complete(auth, tool, args, { ok: false, error });
      return { ...json({ status: "error", error }, true), outcome: { ok: false, error } };
    }
    const outcome = interpretResult(text);
    this.d.guard.complete(auth, tool, args, { ok: outcome.ok, resultId: outcome.resultId, error: outcome.error });
    return { content: [{ type: "text", text }], ...(outcome.ok ? {} : { isError: true }), outcome };
  }

  // -------------------------------------------------------------------------
  // Read tools: pass through
  // -------------------------------------------------------------------------

  async handleRead(session: Session, tool: string, args: Record<string, unknown>): Promise<CallResult> {
    const text = await this.d.executor.run(tool, args);
    const outcome = interpretResult(text);
    if (outcome.ok) this.autoRegisterUntrusted(session, tool, outcome.json);
    return { content: [{ type: "text", text }], ...(outcome.ok ? {} : { isError: true }) };
  }

  /** The other party's words in a dispute are untrusted by definition. */
  private autoRegisterUntrusted(session: Session, tool: string, body: unknown): void {
    if (tool !== "get_dispute" || !body || typeof body !== "object") return;
    const d = body as { dispute_id?: string; messages?: { posted_by?: string; content?: string }[] };
    const registry = this.d.registries.forAgent(session.mandate.agentId);
    (d.messages ?? []).forEach((m, i) => {
      if (typeof m.content === "string" && m.posted_by !== "SELLER") registry.register(`paypal:dispute:${d.dispute_id ?? "?"}:message:${i}`, m.content, this.now());
    });
  }

  // -------------------------------------------------------------------------
  // PayLeash tools
  // -------------------------------------------------------------------------

  registerUntrusted(session: Session, sourceId: string, text: string): CallResult {
    const span = this.d.registries.forAgent(session.mandate.agentId).register(sourceId, text, this.now());
    return json({ registered: true, sourceId, spanId: span.id, spansForAgent: this.d.registries.forAgent(session.mandate.agentId).size });
  }

  status(session: Session): CallResult {
    const { mandate } = session;
    const budgets = Object.entries(mandate.constraints)
      .filter(([, c]) => c.dailyTotal && c.currency)
      .map(([tool, c]) => {
        const limit = parseDecimal(c.dailyTotal!, c.currency!);
        const spent = this.d.policy.spentSince(mandate.agentId, tool, c.currency!, this.now().getTime() - 86_400_000);
        const fmt = (m: number) => formatMinor(m, c.currency!);
        return { tool, currency: c.currency, dailyTotal: fmt(limit), spent: fmt(spent), remaining: fmt(Math.max(0, limit - spent)) };
      });
    return json({
      agentId: mandate.agentId,
      mandate: { id: mandate.id, expiresAt: new Date(mandate.expiresAt * 1000).toISOString(), allowedTools: mandate.allowedTools },
      freeze: this.d.policy.freezeState(mandate.agentId),
      budgets,
      operationsLast24h: this.d.policy.summary(mandate.agentId, this.now()),
      pendingApprovals: this.d.approvals.countPending(mandate.agentId),
    });
  }

  /** What an agent sees for its own approvals. Other agents' approvals look like they do not exist. */
  checkApproval(session: Session, approvalId: string): CallResult {
    const a = this.d.approvals.get(approvalId);
    if (!a || a.agentId !== session.mandate.agentId) return json({ status: "not_found", approvalId }, true);
    return json({ ...this.view(a) });
  }

  // -------------------------------------------------------------------------
  // Owner side
  // -------------------------------------------------------------------------

  view(a: Approval): ApprovalView {
    return {
      status: viewStatus(a.status),
      approvalId: a.id,
      tool: a.tool,
      reasons: groupReasons(a.reasons),
      explanation: a.explanation,
      expiresAt: new Date(a.expiresAtMs).toISOString(),
      ...(a.result !== undefined ? { result: a.result } : {}),
      ...(a.error ? { error: a.error } : {}),
    };
  }

  /** Owner decision. Approving mints a single-use step-up mandate for exactly this call, then runs it. */
  async decide(approvalId: string, decision: "approve" | "deny", note?: string): Promise<ApprovalView & { args: Record<string, unknown>; agentId: string }> {
    const a = this.d.approvals.get(approvalId);
    if (!a) throw new ApprovalError(404, "unknown approval");
    if (a.status !== "pending") throw new ApprovalError(a.status === "expired" ? 410 : 409, `approval is already ${a.status}`);
    const withArgs = (v: ApprovalView) => ({ ...v, args: a.args, agentId: a.agentId });

    if (decision === "deny") {
      if (!this.d.approvals.claim(approvalId)) throw new ApprovalError(409, "approval was decided concurrently");
      this.d.approvals.settle(approvalId, "denied");
      this.d.audit.append({ agent: a.agentId, tool: a.tool, args: a.args, decision: "reject", reasons: [{ code: "owner_denied", message: note ? `Owner denied: ${note.slice(0, 200)}` : "Owner denied the held call." }], mandateId: a.mandateId, ts: this.now() });
      return withArgs(this.view(this.d.approvals.get(approvalId)!));
    }

    if (!this.d.approvals.claim(approvalId)) throw new ApprovalError(409, "approval was decided concurrently");
    this.d.audit.append({ agent: a.agentId, tool: a.tool, args: a.args, decision: "approve", reasons: [{ code: "owner_approved", message: note ? `Owner approved: ${note.slice(0, 200)}` : "Owner approved the held call." }], mandateId: a.mandateId, ts: this.now() });

    try {
      const { token: stepUpToken } = await mintStepUp(
        this.d.stepUpPrivateKey,
        { agentId: a.agentId, tool: a.tool, args: a.args, approvalId, parentMandateId: a.mandateId },
        { issuer: "payleash-proxy", now: this.now() },
      );
      const mandateToken = this.d.approvals.mandateTokenOf(approvalId)!;
      const auth = await this.d.guard.authorize({ mandateToken, tool: a.tool, args: a.args, stepUpToken });
      if (auth.decision !== "allow") {
        // The world changed since the hold (frozen, mandate expired, PayPal balance moved): the approval does not override hard rules.
        const error = `Not executed after approval: ${groupReasons(auth.reasons).map((r) => r.message).join(" ")}`;
        this.d.approvals.settle(approvalId, "failed", { error });
        return withArgs(this.view(this.d.approvals.get(approvalId)!));
      }
      const res = await this.execute(auth, a.tool, a.args);
      if (res.outcome.ok) this.d.approvals.settle(approvalId, "executed", { result: res.outcome.json ?? res.content[0]!.text });
      else this.d.approvals.settle(approvalId, "failed", { error: res.outcome.error, result: res.outcome.json });
    } catch (e) {
      this.d.approvals.settle(approvalId, "failed", { error: e instanceof Error ? e.message : String(e) });
    }
    return withArgs(this.view(this.d.approvals.get(approvalId)!));
  }

  ownerView(a: Approval): OwnerApprovalView {
    const { reasons: _r, ...base } = this.view(a);
    return {
      ...base,
      agentId: a.agentId,
      args: a.args,
      createdAt: new Date(a.createdAtMs).toISOString(),
      ...(a.decidedAtMs ? { decidedAt: new Date(a.decidedAtMs).toISOString() } : {}),
      reasons: groupReasons(a.reasons).map((r) => ({ ...r, ...reasonInfo(r.code) })),
      ...(a.context ? { context: a.context } : {}),
    };
  }

  /** Newest first. `status` narrows; with none, everything the store keeps. */
  listOwnerApprovals(status?: Approval["status"]): OwnerApprovalView[] {
    return this.d.approvals.list(status).map((a) => this.ownerView(a));
  }

  listApprovals(status?: Approval["status"]): ApprovalView[] {
    return this.d.approvals.list(status).map((a) => ({ ...this.view(a), ...{ agentId: a.agentId, args: a.args } }));
  }

  freeze(agentId: string | undefined, reason?: string): void {
    this.d.policy.freeze({ agentId }, reason, this.now());
    this.d.audit.append({ agent: agentId ?? "*", tool: "payleash_freeze", args: { agentId: agentId ?? null }, decision: "freeze", reasons: [{ code: agentId ? "frozen_agent" : "frozen_global", message: reason ?? "Kill switch engaged by the owner." }], ts: this.now() });
  }

  unfreeze(agentId: string | undefined): boolean {
    const changed = this.d.policy.unfreeze({ agentId });
    this.d.audit.append({ agent: agentId ?? "*", tool: "payleash_unfreeze", args: { agentId: agentId ?? null }, decision: "unfreeze", reasons: [{ code: "unfrozen", message: "Kill switch lifted by the owner." }], ts: this.now() });
    return changed;
  }

  verifyAudit(expectedHead?: string) {
    return this.d.audit.verify({ expectedHead });
  }
}

export { callHash };
