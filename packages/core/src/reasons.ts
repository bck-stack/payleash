import type { Reason } from "./policy/types.js";

/**
 * Reasons as a human sees them: one row per `code`. The same code can be reported by several arguments
 * (two tainted values) or by two layers (firewall and policy both notice an unverifiable payee). The audit log
 * keeps every reason with its full detail; people get one line per code with a count and the details underneath.
 */
export interface HumanReason extends Reason {
  /** How many raw reasons carried this code. */
  count: number;
  /** Every distinct message that was folded into this row (always at least one). */
  details: string[];
}

export function groupReasons(reasons: readonly Reason[]): HumanReason[] {
  const byCode = new Map<string, HumanReason>();
  for (const r of reasons) {
    const hit = byCode.get(r.code);
    if (!hit) {
      byCode.set(r.code, { code: r.code, message: r.message, count: 1, details: [r.message] });
      continue;
    }
    hit.count += 1;
    if (!hit.details.includes(r.message)) hit.details.push(r.message);
  }
  return [...byCode.values()];
}

export interface ReasonInfo {
  /** Short title for a badge. */
  title: string;
  /** What the rule means, in plain language. */
  meaning: string;
  /** What the owner can do about it. */
  action: string;
}

/**
 * Plain-language catalogue of every reason code PayLeash can report. The dashboard shows `meaning` and `action`
 * next to the technical message. Unknown codes fall back to the code itself.
 */
export const REASON_CATALOG: Readonly<Record<string, ReasonInfo>> = {
  // --- policy ---
  frozen_global: { title: "Kill switch (all agents)", meaning: "You switched every agent's write access off.", action: "Lift the kill switch on the Overview page when the incident is over." },
  frozen_agent: { title: "Agent frozen", meaning: "You froze this agent, so all its write calls are refused.", action: "Unfreeze the agent on the Overview page." },
  mandate_not_yet_valid: { title: "Mandate not valid yet", meaning: "The agent's signed mandate starts in the future.", action: "Issue a new mandate or wait until it starts." },
  mandate_expired: { title: "Mandate expired", meaning: "The agent's signed mandate has run out.", action: "Issue a fresh mandate on the Policies page." },
  tool_not_allowed: { title: "Tool not allowed", meaning: "The mandate does not list this PayPal tool for this agent.", action: "Add the tool to the policy if the agent should be able to use it." },
  currency_mismatch: { title: "Wrong currency", meaning: "The mandate only allows another currency.", action: "Check the policy's currency, or deny the call." },
  payee_not_original_buyer: { title: "Payee is not the buyer", meaning: "The agent wants to pay someone who did not pay for the order. PayPal refunds the original buyer only, so this is a classic attack pattern.", action: "Deny it. Nothing was sent to PayPal." },
  payee_unverifiable: {
    title: "Buyer email unverifiable",
    meaning:
      "The policy wants the payee to be the original buyer, but PayPal does not show the buyer's email for this order. This is normal for card payments in the sandbox: PayPal returns no payer email there. A refund itself is safe, because PayPal always refunds the original payment source.",
    action: "If you recognise the order and the amount, approve it. It only appears when the agent names a payee; refunds without a payee are not affected.",
  },
  order_age_unverifiable: { title: "Order date unknown", meaning: "The policy limits order age, but PayPal does not show when the order was made.", action: "Check the order in PayPal, then approve or deny." },
  order_too_old: { title: "Order too old", meaning: "The order is older than the policy's age window.", action: "Deny it, or widen the age window in the policy." },
  amount_unknown: { title: "Amount unknown", meaning: "PayLeash could not work out how much money this call moves.", action: "Check the call's details before approving." },
  exceeds_max_per_op: { title: "Above the per-operation limit", meaning: "The amount is larger than the most the policy allows in one operation. A human cannot approve past this limit.", action: "Raise the limit in the policy if this is legitimate." },
  daily_total_exceeded: { title: "Daily budget used up", meaning: "Together with the last 24 hours this would pass the policy's daily total.", action: "Wait for the budget to roll over, or raise the daily total." },
  no_auto_approve_threshold: { title: "No auto-approve limit set", meaning: "The policy has no amount below which the agent may act alone, so a human decides every call.", action: "Set an auto-approve threshold if small calls should run by themselves." },
  above_auto_approve_threshold: { title: "Above the auto-approve limit", meaning: "The amount is within the limits but above what the agent may do alone.", action: "Approve or deny it." },
  // --- provenance firewall ---
  tainted_argument: { title: "Value came from untrusted text", meaning: "A value in this call (an amount, email or id) appears only in a customer email, ticket or dispute message, and PayPal's own records do not confirm it. That is how prompt injection looks.", action: "Compare with the order in PayPal. Approve only if you recognise it." },
  unknown_id: { title: "Unknown PayPal id", meaning: "PayPal has no capture, order, dispute or invoice with this id.", action: "Deny it. The id was probably invented." },
  refund_exceeds_balance: { title: "Refund larger than what is left", meaning: "The refund is more than the captured amount minus refunds that already happened.", action: "Deny it. PayPal would refuse it as well." },
  refund_balance_unverifiable: { title: "Refund balance unknown", meaning: "PayPal does not show how much of this capture was refunded already.", action: "Check the order in PayPal before approving." },
  capture_not_refundable: { title: "Capture cannot be refunded", meaning: "PayPal shows a status that does not allow refunds.", action: "Deny it." },
  order_not_capturable: { title: "Order already closed", meaning: "The order is completed or voided.", action: "Deny it." },
  dispute_not_open: { title: "Dispute already resolved", meaning: "The dispute is closed, so it cannot be accepted.", action: "Deny it." },
  amount_exceeds_invoice: { title: "Amount above the invoice", meaning: "The amount is larger than the invoice total.", action: "Deny it." },
  refund_exceeds_paid: { title: "Refund above what was paid", meaning: "The invoice was paid less than this refund.", action: "Deny it." },
  recipient_not_on_invoice: { title: "Recipient not on the invoice", meaning: "Sending would show the invoice to a third party.", action: "Deny it unless you know this person." },
  currency_mismatch_truth: { title: "Currency differs from PayPal's record", meaning: "The call uses another currency than the order.", action: "Deny it." },
  ground_truth_unavailable: { title: "PayPal could not be checked", meaning: "PayLeash could not read PayPal's records, so it refused (fail closed).", action: "Check credentials, network and the token cache (see the troubleshooting guide)." },
  invalid_arguments: { title: "Malformed call", meaning: "The call's arguments are missing or invalid.", action: "Deny it." },
  invalid_amount: { title: "Invalid amount", meaning: "The amount is not a valid positive number.", action: "Deny it." },
  missing_argument: { title: "Missing argument", meaning: "A required value is missing.", action: "Deny it." },
  // --- guard / mandate ---
  tool_unclassified: { title: "Tool not modelled", meaning: "PayLeash does not know how to check this PayPal tool, so it refuses it.", action: "Nothing to do; this is the safe default." },
  step_up_approved: { title: "You approved it", meaning: "A single-use approval you gave was applied to this exact call.", action: "None." },
  owner_approved: { title: "Approved by the owner", meaning: "You approved this held call.", action: "None." },
  owner_denied: { title: "Denied by the owner", meaning: "You denied this held call.", action: "None." },
  execution_failed: { title: "PayPal refused it", meaning: "The call was allowed but PayPal returned an error.", action: "Read the message; the budget was released." },
  mandate_bad_signature: { title: "Mandate not signed by you", meaning: "The mandate was changed or signed with another key.", action: "Issue a new mandate." },
  mandate_expired_token: { title: "Mandate expired", meaning: "The mandate has run out.", action: "Issue a fresh mandate." },
};

export function reasonInfo(code: string): ReasonInfo {
  const hit = REASON_CATALOG[code];
  if (hit) return hit;
  if (code.startsWith("mandate_")) return { title: "Mandate rejected", meaning: "The agent's mandate did not verify.", action: "Issue a fresh mandate." };
  if (code.startsWith("step_up_")) return { title: "Approval rejected", meaning: "The one-time approval did not match this call or was already used.", action: "Approve the call again from the Approvals page." };
  return { title: code, meaning: "No plain-language text for this reason yet.", action: "See the technical message." };
}
