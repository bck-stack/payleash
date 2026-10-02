import { formatMinor, parseDecimal } from "./money.js";
import type { OperationFacts } from "./policy/types.js";
import type { ArgAssessment, TaintTruth } from "./taint/evaluate.js";

/**
 * Plain-language view of a held call, built from PayPal's own records and the firewall's assessment.
 * It is stored with the approval so the owner sees exactly what the agent asked for and why it was held.
 */
export type Origin = "paypal" | "customer_email" | "support_ticket" | "dispute_message" | "web_page" | "untrusted_text" | "unknown";

export interface ProvenanceEntry {
  /** Argument path as the agent sent it, e.g. `amount.value`. */
  path: string;
  /** What the value means: amount, payee_email, capture_id, ... */
  role: string;
  /** What that role is called for a person. */
  roleLabel: string;
  value: string;
  status: "verified" | "tainted" | "unknown";
  origin: Origin;
  /** E.g. "PayPal-verified", "customer email (gmail:msg-1)". */
  label: string;
  detail: string;
  sources: string[];
}

export interface CallFact {
  label: string;
  value: string;
}

export interface CallContext {
  /** One sentence: "Refund $60.00 on order 5O19…, captured $72.50, buyer alice@example.com". */
  summary: string;
  facts: CallFact[];
  provenance: ProvenanceEntry[];
  amount?: { currency: string; minor: number; text: string };
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
export function moneyText(minor: number, currency: string): string {
  const n = formatMinor(minor, currency);
  const sym = SYMBOL[currency];
  return sym ? `${sym}${n}` : `${n} ${currency}`;
}

const ROLE_LABEL: Record<string, string> = {
  amount: "Amount",
  currency: "Currency",
  payee_email: "Refund goes to",
  recipient_email: "Recipient",
  capture_id: "Payment (capture)",
  order_id: "Order",
  dispute_id: "Dispute",
  invoice_id: "Invoice",
  subscription_id: "Subscription",
};

export function originOf(a: Pick<ArgAssessment, "status" | "sources">): { origin: Origin; label: string } {
  if (a.status === "verified") return { origin: "paypal", label: "PayPal-verified" };
  if (a.status === "unknown") return { origin: "unknown", label: "Unknown: not in PayPal's records and not in anything the agent read" };
  const src = a.sources[0] ?? "";
  const named = (what: string) => `${what}${a.sources.length ? ` (${a.sources.slice(0, 2).join(", ")}${a.sources.length > 2 ? ", ..." : ""})` : ""}`;
  if (/^paypal:dispute:/i.test(src)) return { origin: "dispute_message", label: named("Buyer's dispute message") };
  if (/^(gmail|email|mail|imap|outlook|inbox)\b/i.test(src)) return { origin: "customer_email", label: named("Customer email") };
  if (/^(ticket|zendesk|helpdesk|support|intercom|chat)\b/i.test(src)) return { origin: "support_ticket", label: named("Support ticket") };
  if (/^(web|url|http|page|site)\b/i.test(src)) return { origin: "web_page", label: named("Web page") };
  return { origin: "untrusted_text", label: named("Untrusted text") };
}

export function provenanceMap(args: readonly ArgAssessment[]): ProvenanceEntry[] {
  return args.map((a) => {
    const o = originOf(a);
    return { path: a.path, role: a.role, roleLabel: ROLE_LABEL[a.role] ?? a.role, value: a.value, status: a.status, origin: o.origin, label: o.label, detail: a.detail, sources: a.sources };
  });
}

const date = (d?: Date) => (d ? d.toISOString().slice(0, 10) : undefined);
const daysSince = (d: Date | undefined, now: Date) => (d ? Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000)) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);

function argMoney(args: Record<string, unknown>, path = "amount"): { minor: number; currency: string } | undefined {
  const value = str(get(args, `${path}.value`));
  const currency = str(get(args, `${path}.currency_code`))?.toUpperCase();
  if (!value || !currency) return undefined;
  try {
    return { minor: parseDecimal(value, currency), currency };
  } catch {
    return undefined;
  }
}

export interface DescribeInput {
  tool: string;
  args: Record<string, unknown>;
  assessments: readonly ArgAssessment[];
  facts: OperationFacts;
  truth?: TaintTruth | null;
  now?: Date;
}

/** Builds the owner-facing description of a call. Never throws: unknown tools get a generic sentence. */
export function buildCallContext(i: DescribeInput): CallContext {
  const now = i.now ?? new Date();
  const facts: CallFact[] = [];
  const add = (label: string, value: string | undefined) => value && facts.push({ label, value });
  const asked = argMoney(i.args) ?? (i.facts.amount ? { minor: i.facts.amount.minor, currency: i.facts.amount.currency } : undefined);
  const amountText = asked ? moneyText(asked.minor, asked.currency) : undefined;
  let summary: string;

  const t = i.truth;
  switch (t?.kind === undefined ? i.tool : `${i.tool}:${t.kind}`) {
    case "create_refund:capture": {
      const c = (t as Extract<TaintTruth, { kind: "capture" }>).capture;
      const full = !argMoney(i.args);
      const captured = moneyText(c.amount.minor, c.amount.currency);
      const parts = [
        `${full ? "Refund everything that is left" : `Refund ${amountText}`} on ${c.orderId ? `order ${c.orderId}` : `payment ${c.id}`}`,
        `captured ${captured}`,
        c.refundedMinor ? `${moneyText(c.refundedMinor, c.amount.currency)} already refunded` : undefined,
        c.buyerEmail ? `buyer ${c.buyerEmail}` : "buyer not shown by PayPal (card payment)",
      ].filter(Boolean);
      summary = parts.join(", ");
      add("Payment (capture)", c.id);
      add("Order", c.orderId);
      add("Captured", captured);
      if (c.refundedMinor !== undefined) add("Already refunded", moneyText(c.refundedMinor, c.amount.currency));
      if (c.remainingMinor !== undefined) add("Still refundable", moneyText(c.remainingMinor, c.amount.currency));
      add("Buyer", c.buyerEmail ?? "not shown by PayPal");
      add("Order date", date(c.createdAt) && `${date(c.createdAt)} (${daysSince(c.createdAt, now)} days ago)`);
      const payee = str(i.args.payee_email);
      if (payee) add("Agent says it goes to", payee);
      break;
    }
    case "accept_dispute_claim:dispute": {
      const d = (t as Extract<TaintTruth, { kind: "dispute" }>).dispute;
      summary = `Accept dispute ${d.id}${d.amount ? ` and give up ${moneyText(d.amount.minor, d.amount.currency)}` : ""}${d.buyerEmail ? `, buyer ${d.buyerEmail}` : ""}`;
      add("Dispute", d.id);
      add("Status", d.status);
      add("Opened", date(d.createdAt));
      break;
    }
    case "send_invoice:invoice":
    case "send_invoice_reminder:invoice":
    case "record_payment_for_invoice:invoice":
    case "record_refund_for_invoice:invoice": {
      const inv = (t as Extract<TaintTruth, { kind: "invoice" }>).invoice;
      const verb = ({ send_invoice: "Send", send_invoice_reminder: "Send a reminder for", record_payment_for_invoice: "Record a payment of " + (amountText ?? "?") + " on", record_refund_for_invoice: "Record a refund of " + (amountText ?? "?") + " on" } as Record<string, string>)[i.tool]!;
      summary = `${verb} invoice ${inv.id}${inv.amount ? ` (total ${moneyText(inv.amount.minor, inv.amount.currency)})` : ""}${inv.recipients.length ? ` to ${inv.recipients.join(", ")}` : ""}`;
      add("Invoice", inv.id);
      add("Status", inv.status);
      add("Recipients on file", inv.recipients.join(", ") || undefined);
      const extra = i.args.additional_recipients;
      if (Array.isArray(extra) && extra.length) add("Also sent to", extra.map(String).join(", "));
      break;
    }
    case "cancel_subscription:subscription": {
      const s = (t as Extract<TaintTruth, { kind: "subscription" }>).subscription;
      summary = `Cancel subscription ${s.id}${s.subscriberEmail ? ` of ${s.subscriberEmail}` : ""}`;
      add("Status", s.status);
      break;
    }
    case "pay_order:order": {
      const o = (t as Extract<TaintTruth, { kind: "order" }>).order;
      summary = `Pay order ${o.id}${o.amount ? ` for ${moneyText(o.amount.minor, o.amount.currency)}` : ""}`;
      break;
    }
    default: {
      const named = i.tool.replace(/_/g, " ");
      summary = `${named.charAt(0).toUpperCase()}${named.slice(1)}${amountText ? ` for ${amountText}` : ""}`;
      const ids = i.assessments.filter((a) => /_id$/.test(a.role)).map((a) => a.value);
      if (ids.length) summary += ` (${ids.join(", ")})`;
    }
  }
  return {
    summary,
    facts,
    provenance: provenanceMap(i.assessments),
    ...(asked ? { amount: { currency: asked.currency, minor: asked.minor, text: moneyText(asked.minor, asked.currency) } } : {}),
  };
}
