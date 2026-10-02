import type { Money } from "../money.js";

export type Decision = "allow" | "hold" | "deny";

/** `code` is stable and machine readable; `message` is for humans. */
export interface Reason {
  code: string;
  message: string;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Facts about the operation that the policy may need. They are derived from PayPal ground truth
 * (never from untrusted text) by the taint layer before the policy runs.
 */
export interface OperationFacts {
  /** Amount at stake: the call's amount, or the full remaining amount when the call omits it. */
  amount?: Money;
  /** Destination declared in the call, if the call declares one. */
  payeeEmail?: string;
  /** Buyer of the original order, from PayPal. */
  originalBuyerEmail?: string;
  /** When the underlying order / capture / dispute was created, from PayPal. */
  transactionTime?: Date;
}

export type FreezeState =
  | { frozen: false }
  | { frozen: true; scope: "global" | "agent"; reason?: string };

/** Read side of the policy state. The SQLite implementation is in `policy/store.ts`. */
export interface PolicyStore {
  freezeState(agentId: string): FreezeState;
  /** Executed + reserved amount for this agent/tool/currency since `sinceMs` (epoch ms). */
  spentSince(agentId: string, tool: string, currency: string, sinceMs: number): number;
}

export interface PolicyContext {
  now: Date;
  facts: OperationFacts;
  store: PolicyStore;
  /**
   * True for tools that move or commit an amount (refund, pay_order, ...). When true and the amount
   * cannot be determined, the call is held rather than waved through.
   */
  amountBearing?: boolean;
}

export interface PolicyResult {
  decision: Decision;
  reasons: Reason[];
}
