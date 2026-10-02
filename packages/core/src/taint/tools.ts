import { formatMinor, parseDecimal } from "../money.js";

/**
 * For every write tool of the PayPal Agent Toolkit: which arguments are critical and what PayPal object
 * is the ground truth for them. The proxy refuses to run a write tool that has no descriptor here.
 */
export type ArgRole =
  | "amount"
  | "currency"
  | "payee_email" // where money would go; must be the original buyer
  | "recipient_email" // who would be contacted / billed
  | "capture_id"
  | "order_id"
  | "dispute_id"
  | "invoice_id"
  | "subscription_id";

export interface CriticalArg {
  /** Argument path as the agent supplied it, for explanations. */
  path: string;
  role: ArgRole;
  value: string;
}

export type TruthKind = "capture" | "order" | "dispute" | "invoice" | "subscription" | "none";

export class ArgumentError extends Error {}

export interface ToolDescriptor {
  tool: string;
  kind: TruthKind;
  /**
   * The operation commits an amount. If the amount cannot be determined the call is held,
   * and mandate thresholds / limits apply when it can.
   */
  amountBearing: boolean;
  critical(args: Record<string, unknown>): CriticalArg[];
}

type Args = Record<string, unknown>;
const get = (a: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Args)[k] : undefined), a);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);

function one(args: Args, path: string, role: ArgRole): CriticalArg[] {
  const v = str(get(args, path));
  return v === undefined ? [] : [{ path, role, value: v }];
}
function many(args: Args, path: string, role: ArgRole): CriticalArg[] {
  const arr = get(args, path);
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((v, i) => (str(v) ? [{ path: `${path}[${i}]`, role, value: str(v)! }] : []));
}
const moneyArg = (args: Args, path: string): CriticalArg[] => [
  ...one(args, `${path}.value`, "amount"),
  ...one(args, `${path}.currency_code`, "currency"),
];

/** Sum of items[].unit_amount * quantity for create_invoice / create_recurring_series. */
function itemsTotal(args: Args): CriticalArg[] {
  const items = get(args, "items");
  const currency = str(get(args, "currency_code"));
  if (!Array.isArray(items) || !items.length || !currency) return [];
  let total = 0;
  try {
    for (const it of items as Args[]) {
      const qty = Number(str(it.quantity) ?? "1");
      if (!Number.isInteger(qty) || qty < 1) throw new ArgumentError("item quantity must be a positive whole number");
      total += parseDecimal(str(get(it, "unit_amount.value")) ?? "", currency) * qty;
    }
  } catch (e) {
    throw new ArgumentError(`cannot compute the invoice total: ${e instanceof Error ? e.message : String(e)}`);
  }
  return [
    { path: "items", role: "amount", value: formatMinor(total, currency) },
    { path: "currency_code", role: "currency", value: currency },
  ];
}
const primaryRecipients = (args: Args): CriticalArg[] => {
  const rs = get(args, "primary_recipients");
  if (!Array.isArray(rs)) return [];
  return rs.flatMap((r, i) => one(r as Args, "billing_info.email_address", "recipient_email").map((c) => ({ ...c, path: `primary_recipients[${i}].${c.path}` })));
};

const d = (tool: string, kind: TruthKind, amountBearing: boolean, critical: ToolDescriptor["critical"] = () => []): [string, ToolDescriptor] => [
  tool,
  { tool, kind, amountBearing, critical },
];

export const TOOL_DESCRIPTORS: Readonly<Record<string, ToolDescriptor>> = Object.fromEntries([
  // --- payments ---------------------------------------------------------
  d("create_refund", "capture", true, (a) => [
    ...one(a, "capture_id", "capture_id"),
    ...moneyArg(a, "amount"),
    // PayLeash extension: who the agent believes receives the refund. Stripped before the call reaches PayPal.
    ...one(a, "payee_email", "payee_email"),
  ]),
  d("pay_order", "order", true, (a) => one(a, "id", "order_id")),
  d("create_order", "none", false),

  // --- disputes ---------------------------------------------------------
  d("accept_dispute_claim", "dispute", true, (a) => one(a, "dispute_id", "dispute_id")),
  // PayLeash's own tool (the toolkit has none): answers a dispute with evidence. Amount-bearing so that, like accepting a claim, it needs a human unless the mandate says otherwise.
  d("provide_dispute_evidence", "dispute", true, (a) => one(a, "dispute_id", "dispute_id")),

  // --- invoices ---------------------------------------------------------
  d("create_invoice", "none", true, (a) => [...itemsTotal(a), ...primaryRecipients(a)]),
  d("send_invoice", "invoice", true, (a) => [...one(a, "invoice_id", "invoice_id"), ...many(a, "additional_recipients", "recipient_email")]),
  d("send_invoice_reminder", "invoice", false, (a) => [...one(a, "invoice_id", "invoice_id"), ...many(a, "additional_recipients", "recipient_email")]),
  d("cancel_sent_invoice", "invoice", false, (a) => [...one(a, "invoice_id", "invoice_id"), ...many(a, "additional_recipients", "recipient_email")]),
  d("delete_invoice", "invoice", false, (a) => one(a, "invoice_id", "invoice_id")),
  d("record_payment_for_invoice", "invoice", true, (a) => [...one(a, "invoice_id", "invoice_id"), ...moneyArg(a, "amount")]),
  d("record_refund_for_invoice", "invoice", true, (a) => [...one(a, "invoice_id", "invoice_id"), ...moneyArg(a, "amount")]),
  d("create_conditional_rules_for_invoice", "invoice", true, (a) => one(a, "invoice_id", "invoice_id")),
  d("cancel_invoice_auto_reminder", "invoice", false, (a) => one(a, "invoice_id", "invoice_id")),
  d("setup_invoice_auto_reminders", "none", false),
  d("update_invoice_auto_reminder", "none", false),
  d("update_invoicing", "none", true), // full replacement of an invoice: amount not modelled, so always held
  d("create_recurring_series", "none", true, (a) => [...itemsTotal(a), ...primaryRecipients(a)]),
  d("activate_recurring_series", "none", true), // starts recurring billing: always held
  d("cancel_recurring_series", "none", false),
  d("delete_recurring_series", "none", false),

  // --- subscriptions ----------------------------------------------------
  d("cancel_subscription", "subscription", false, (a) => one(a, "subscription_id", "subscription_id")),
  d("update_subscription", "subscription", true, (a) => one(a, "subscription_id", "subscription_id")), // price changes: always held
  d("create_subscription", "none", false, (a) => one(a, "subscriber.email_address", "recipient_email")),
  d("create_subscription_plan", "none", false),
  d("update_plan", "none", true), // plan price changes: always held

  // --- catalog and shipping ---------------------------------------------
  d("create_product", "none", false),
  d("update_product", "none", false),
  d("create_shipment_tracking", "none", false),
  d("update_shipment_tracking", "none", false),
]);

export function descriptorFor(tool: string): ToolDescriptor | undefined {
  return Object.hasOwn(TOOL_DESCRIPTORS, tool) ? TOOL_DESCRIPTORS[tool] : undefined;
}
