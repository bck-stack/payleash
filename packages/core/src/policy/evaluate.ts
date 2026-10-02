import type { Mandate } from "../mandate/schema.js";
import { formatMinor, parseDecimal } from "../money.js";
import type { PolicyContext, PolicyResult, Reason, ToolCall } from "./types.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

const norm = (e: string) => e.trim().toLowerCase();

/**
 * Deterministic policy evaluation. No I/O, no clocks, no randomness: the same
 * (mandate, call, context) always gives the same answer. Only invoked for write tools.
 *
 * Precedence: deny > hold > allow. All applicable reasons are reported.
 * Absent `autoApproveThreshold`, an amount-bearing call is held for a human (safe by default).
 */
export function evaluatePolicy(mandate: Mandate, call: ToolCall, ctx: PolicyContext): PolicyResult {
  const denies: Reason[] = [];
  const holds: Reason[] = [];
  const deny = (code: string, message: string) => denies.push({ code, message });
  const hold = (code: string, message: string) => holds.push({ code, message });
  const finish = (): PolicyResult =>
    denies.length ? { decision: "deny", reasons: [...denies, ...holds] } : holds.length ? { decision: "hold", reasons: holds } : { decision: "allow", reasons: [] };

  // 1. Kill switch beats everything.
  const freeze = ctx.store.freezeState(mandate.agentId);
  if (freeze.frozen) {
    deny(
      freeze.scope === "global" ? "frozen_global" : "frozen_agent",
      `${freeze.scope === "global" ? "All" : `Agent "${mandate.agentId}"`} write operations are frozen${freeze.reason ? `: ${freeze.reason}` : ""}.`,
    );
    return finish();
  }

  // 2. Mandate validity window and tool allow-list.
  const nowSec = Math.floor(ctx.now.getTime() / 1000);
  if (nowSec < mandate.notBefore) deny("mandate_not_yet_valid", "The mandate is not valid yet.");
  if (nowSec >= mandate.expiresAt) deny("mandate_expired", "The mandate has expired.");
  if (!mandate.allowedTools.includes(call.tool)) {
    deny("tool_not_allowed", `Tool "${call.tool}" is not allowed by this mandate.`);
  }
  if (denies.length) return finish();

  const c = mandate.constraints[call.tool] ?? {};
  const { facts } = ctx;
  const amount = facts.amount;

  // 3. Currency.
  if (c.currency && amount && amount.currency !== c.currency) {
    deny("currency_mismatch", `The mandate allows ${c.currency} but the operation is in ${amount.currency}.`);
  }

  // 4. Payee must be the original buyer.
  if (c.payeeMustBeOriginalBuyer && facts.payeeEmail !== undefined) {
    if (facts.originalBuyerEmail === undefined) {
      hold("payee_unverifiable", "The mandate requires the payee to be the original buyer, but PayPal does not show the buyer's email.");
    } else if (norm(facts.payeeEmail) !== norm(facts.originalBuyerEmail)) {
      deny("payee_not_original_buyer", `Payee ${facts.payeeEmail} is not the original buyer (${facts.originalBuyerEmail}).`);
    }
  }

  // 5. Order age window.
  if (c.orderAgeDays !== undefined) {
    if (!facts.transactionTime) {
      hold("order_age_unverifiable", "The mandate limits order age, but PayPal does not show when the order was created.");
    } else {
      const ageDays = (ctx.now.getTime() - facts.transactionTime.getTime()) / DAY_MS;
      if (ageDays > c.orderAgeDays) {
        deny("order_too_old", `The order is ${Math.floor(ageDays)} days old; the mandate allows ${c.orderAgeDays}.`);
      }
    }
  }

  // 6. Amount limits.
  if (!amount) {
    if (ctx.amountBearing) hold("amount_unknown", "The amount of this operation could not be determined.");
  } else if (!denies.some((d) => d.code === "currency_mismatch")) {
    const cur = amount.currency;
    const max = c.maxAmountPerOp !== undefined ? parseDecimal(c.maxAmountPerOp, cur) : undefined;
    const daily = c.dailyTotal !== undefined ? parseDecimal(c.dailyTotal, cur) : undefined;
    const threshold = c.autoApproveThreshold !== undefined ? parseDecimal(c.autoApproveThreshold, cur) : undefined;
    const fmt = (minor: number) => `${formatMinor(minor, cur)} ${cur}`;

    if (max !== undefined && amount.minor > max) {
      deny("exceeds_max_per_op", `${fmt(amount.minor)} exceeds the per-operation limit of ${fmt(max)}.`);
    }
    if (daily !== undefined) {
      const spent = ctx.store.spentSince(mandate.agentId, call.tool, cur, ctx.now.getTime() - DAY_MS);
      if (spent + amount.minor > daily) {
        deny("daily_total_exceeded", `${fmt(spent)} already used in the last 24h; adding ${fmt(amount.minor)} would exceed the daily total of ${fmt(daily)}.`);
      }
    }
    if (ctx.amountBearing || threshold !== undefined) {
      if (threshold === undefined) {
        hold("no_auto_approve_threshold", "The mandate has no auto-approve threshold for this tool, so a human must approve.");
      } else if (amount.minor > threshold) {
        hold("above_auto_approve_threshold", `${fmt(amount.minor)} is above the auto-approve threshold of ${fmt(threshold)}.`);
      }
    }
  }

  return finish();
}
