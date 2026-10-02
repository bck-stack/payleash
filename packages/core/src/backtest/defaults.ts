import type { Mandate, MandateInput } from "../mandate/schema.js";

/** The mandate of `examples/mandate.support-agent.json`: what the backtest replays when no agent is selected. */
export const EXAMPLE_SUPPORT_MANDATE: MandateInput = {
  agentId: "support-agent",
  allowedTools: ["create_refund", "get_order", "get_dispute", "send_invoice", "cancel_subscription", "show_subscription_details"],
  constraints: {
    create_refund: { currency: "USD", maxAmountPerOp: "100.00", dailyTotal: "300.00", autoApproveThreshold: "25.00", payeeMustBeOriginalBuyer: true, orderAgeDays: 60 },
    send_invoice: { currency: "USD", maxAmountPerOp: "500.00", autoApproveThreshold: "100.00" },
    cancel_subscription: {},
  },
};

/** The part of a verified mandate an owner writes: no id, issuer or validity window. */
export function mandateToInput(m: Mandate): MandateInput {
  return { agentId: m.agentId, allowedTools: [...m.allowedTools], constraints: JSON.parse(JSON.stringify(m.constraints)) };
}
