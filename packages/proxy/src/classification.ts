/**
 * Explicit classification of every tool in @paypal/agent-toolkit (pinned to 1.11.0).
 *
 *  - "read":  passes straight through to PayPal.
 *  - "write": goes through mandate -> policy -> provenance firewall -> execute | hold | deny.
 *
 * A new toolkit tool that is not listed here is NOT exposed by the proxy (fail closed), and
 * `test/classification.test.ts` fails until someone classifies it. Never default an unknown tool to "read".
 */
export type ToolAccess = "read" | "write";

export const TOOL_CLASSIFICATION: Readonly<Record<string, ToolAccess>> = {
  // --- invoices: read -----------------------------------------------------
  list_invoices: "read",
  get_invoice: "read",
  search_invoicing: "read",
  generate_invoice_qr_code: "read", // POST, but only renders a QR code
  generate_invoice_number: "read", // POST, but does not reserve or persist anything
  get_recurring_series: "read",
  // --- invoices: write ----------------------------------------------------
  create_invoice: "write",
  create_recurring_series: "write",
  activate_recurring_series: "write",
  cancel_recurring_series: "write",
  delete_recurring_series: "write",
  send_invoice: "write",
  send_invoice_reminder: "write",
  cancel_sent_invoice: "write",
  delete_invoice: "write",
  setup_invoice_auto_reminders: "write",
  update_invoice_auto_reminder: "write",
  update_invoicing: "write",
  cancel_invoice_auto_reminder: "write",
  record_payment_for_invoice: "write",
  record_refund_for_invoice: "write",
  create_conditional_rules_for_invoice: "write",

  // --- catalog ------------------------------------------------------------
  list_products: "read",
  show_product_details: "read",
  create_product: "write",
  update_product: "write",

  // --- subscriptions ------------------------------------------------------
  list_subscription_plans: "read",
  show_subscription_plan_details: "read",
  show_subscription_details: "read",
  create_subscription_plan: "write",
  update_plan: "write",
  create_subscription: "write",
  update_subscription: "write",
  cancel_subscription: "write",

  // --- shipment tracking --------------------------------------------------
  get_shipment_tracking: "read",
  create_shipment_tracking: "write",
  update_shipment_tracking: "write",

  // --- orders and payments ------------------------------------------------
  get_order: "read",
  get_refund: "read",
  create_order: "write",
  pay_order: "write",
  create_refund: "write",

  // --- disputes -----------------------------------------------------------
  list_disputes: "read",
  get_dispute: "read",
  accept_dispute_claim: "write",

  // --- reporting ----------------------------------------------------------
  list_transactions: "read",
  get_merchant_insights: "read",
};

export const accessOf = (tool: string): ToolAccess | undefined => (Object.hasOwn(TOOL_CLASSIFICATION, tool) ? TOOL_CLASSIFICATION[tool] : undefined);
