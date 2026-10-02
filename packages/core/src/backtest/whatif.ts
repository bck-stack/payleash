import type { Mandate, ToolConstraints } from "../mandate/schema.js";
import { evaluatePolicy, type FreezeState, type PolicyStore } from "../policy/index.js";
import { combineVerdicts } from "../guard.js";
import { groupReasons } from "../reasons.js";
import { descriptorFor } from "../taint/tools.js";
import { parseDecimal } from "../money.js";
import type { ActionResult } from "./report.js";

/** In-memory budget ledger for a replay: nothing touches SQLite or PayPal. */
export class MemoryPolicyStore implements PolicyStore {
  private readonly ledger: { agentId: string; tool: string; currency: string; minor: number; atMs: number }[] = [];
  freezeState(): FreezeState {
    return { frozen: false };
  }
  spentSince(agentId: string, tool: string, currency: string, sinceMs: number): number {
    return this.ledger.filter((e) => e.agentId === agentId && e.tool === tool && e.currency === currency && e.atMs > sinceMs).reduce((a, e) => a + e.minor, 0);
  }
  add(agentId: string, tool: string, currency: string, minor: number, atMs: number): void {
    this.ledger.push({ agentId, tool, currency, minor, atMs });
  }
}

export interface PolicyOverrides {
  tool?: string;
  /** Decimal strings, as in a mandate. */
  autoApproveThreshold?: string;
  maxAmountPerOp?: string;
  dailyTotal?: string;
}

export function applyOverrides(mandate: Mandate, o: PolicyOverrides): Mandate {
  const tool = o.tool ?? "create_refund";
  const current: ToolConstraints = mandate.constraints[tool] ?? {};
  const next: ToolConstraints = { ...current };
  for (const key of ["autoApproveThreshold", "maxAmountPerOp", "dailyTotal"] as const) {
    const v = o[key];
    if (v === undefined) continue;
    parseDecimal(v, current.currency ?? "USD"); // throws on a malformed amount
    next[key] = v;
    if (!next.currency) next.currency = "USD";
  }
  return { ...mandate, constraints: { ...mandate.constraints, [tool]: next } };
}

/**
 * Re-runs ONLY the policy over a finished replay, in memory: the firewall's verdicts are kept as they were
 * (they do not depend on limits), the policy is evaluated again with `overrides` applied, and the rolling budget is
 * rebuilt in time order. With no overrides the result is identical to the guard's own run.
 */
export function rerunPolicy(results: readonly ActionResult[], mandate: Mandate, overrides: PolicyOverrides = {}): ActionResult[] {
  const m = applyOverrides(mandate, overrides);
  const store = new MemoryPolicyStore();
  const ordered = [...results].sort((a, b) => Date.parse(a.action.at) - Date.parse(b.action.at));
  return ordered.map((r) => {
    const now = new Date(r.action.at);
    const call = { tool: r.action.tool, args: r.action.args };
    const amountBearing = descriptorFor(r.action.tool)?.amountBearing ?? false;
    const facts = {
      amount: r.facts.amount,
      payeeEmail: r.facts.payeeEmail,
      originalBuyerEmail: r.facts.originalBuyerEmail,
      transactionTime: r.facts.transactionTime ? new Date(r.facts.transactionTime) : undefined,
    };
    const policy = evaluatePolicy(m, call, { now, facts, store, amountBearing });
    const combined = combineVerdicts(r.taint, policy);
    if (combined.decision === "allow" && facts.amount && amountBearing) store.add(m.agentId, r.action.tool, facts.amount.currency, facts.amount.minor, now.getTime());
    return {
      ...r,
      decision: combined.decision,
      rawReasons: combined.reasons,
      reasons: groupReasons(combined.reasons),
      policy: { decision: policy.decision, reasons: policy.reasons },
      ...(r.action.attack ? { caught: combined.decision !== "allow" } : {}),
    };
  });
}
