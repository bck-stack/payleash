import { buildDemoFixtures, type FixtureResponses } from "@payleash/core";
import type { ToolExecutor } from "./executor.js";

type Json = Record<string, any>;

/**
 * A stand-in for PayPal for demos and tests without sandbox credentials (`--fixtures`).
 * It answers the same raw shapes as the real API and keeps the shared `responses` consistent after a refund,
 * so the provenance firewall sees the new balance on the next call.
 */
export class FixtureExecutor implements ToolExecutor {
  readonly calls: { method: string; args: Record<string, unknown> }[] = [];
  private counter = 0;

  constructor(readonly responses: FixtureResponses = buildDemoFixtures()) {}

  async run(method: string, args: Record<string, unknown>): Promise<string> {
    this.calls.push({ method, args });
    const r = this.responses;
    switch (method) {
      case "get_order":
        return JSON.stringify(r[`/v2/checkout/orders/${args.id}`] ?? notFound("order"));
      case "get_dispute":
        return JSON.stringify(r[`/v1/customer/disputes/${args.dispute_id}`] ?? notFound("dispute"));
      case "get_invoice":
        return JSON.stringify(r[`/v2/invoicing/invoices/${args.invoice_id}`] ?? notFound("invoice"));
      case "show_subscription_details":
        return JSON.stringify(r[`/v1/billing/subscriptions/${args.subscription_id}`] ?? notFound("subscription"));
      case "list_disputes": {
        const items = Object.entries(r)
          .filter(([path]) => path.startsWith("/v1/customer/disputes/"))
          .map(([, d]) => d as Json)
          .filter((d) => d.status === "WAITING_FOR_SELLER_RESPONSE" || d.status === "OPEN")
          .map((d) => ({ dispute_id: d.dispute_id, status: d.status, reason: d.reason, dispute_amount: d.dispute_amount, create_time: d.create_time }));
        return JSON.stringify({ items });
      }
      case "list_transactions": {
        const items = Object.entries(r)
          .filter(([path]) => path.startsWith("/v2/payments/captures/"))
          .map(([, c]) => ({ transaction_info: { transaction_id: (c as Json).id, transaction_amount: (c as Json).amount, transaction_initiation_date: (c as Json).create_time } }));
        return JSON.stringify({ transaction_details: items });
      }
      case "create_refund":
        return JSON.stringify(this.refund(args));
      case "get_shipment_tracking":
        return JSON.stringify(r[`/v1/shipping/trackers/${args.transaction_id}`] ?? notFound("tracker"));
      case "provide_dispute_evidence": {
        const d = r[`/v1/customer/disputes/${args.dispute_id}`] as Json | undefined;
        if (!d) return JSON.stringify(notFound("dispute"));
        d.evidences = [...(d.evidences ?? []), ...((args.evidences as Json[] | undefined) ?? [])];
        d.status = "UNDER_REVIEW";
        return JSON.stringify({ links: [{ href: `https://api.sandbox.paypal.com/v1/customer/disputes/${args.dispute_id}`, rel: "self", method: "GET" }] });
      }
      case "cancel_subscription": {
        const s = r[`/v1/billing/subscriptions/${args.subscription_id}`] as Json | undefined;
        if (!s) return JSON.stringify(notFound("subscription"));
        s.status = "CANCELLED";
        return JSON.stringify({ status: "CANCELLED", subscription_id: args.subscription_id });
      }
      default:
        return JSON.stringify({ fixture: true, method, args });
    }
  }

  private refund(args: Record<string, unknown>): Json {
    const capId = String(args.capture_id);
    const cap = this.responses[`/v2/payments/captures/${capId}`] as Json | undefined;
    if (!cap) return notFound("capture");
    const orderPath = `/v2/checkout/orders/${String(cap.links?.find((l: Json) => l.rel === "up")?.href).split("/").pop()}`;
    const order = this.responses[orderPath] as Json | undefined;
    const unit = order?.purchase_units?.[0];
    const refunds: Json[] = unit?.payments?.refunds ?? [];
    const refunded = refunds.reduce((a, x) => a + Number(x.amount.value), 0);
    const capTotal = Number(cap.amount.value);
    const amount = (args.amount as Json | undefined) ?? { currency_code: cap.amount.currency_code, value: (capTotal - refunded).toFixed(2) };
    if (Number(amount.value) > capTotal - refunded + 1e-9) {
      return { name: "UNPROCESSABLE_ENTITY", message: "The refund amount must be less than or equal to the capture amount that has not yet been refunded.", debug_id: "fixture", error: { message: "REFUND_AMOUNT_EXCEEDED", type: "paypal_error" } };
    }
    const refund = {
      id: `FIXREFUND${String(++this.counter).padStart(8, "0")}`,
      status: "COMPLETED",
      amount,
      create_time: new Date().toISOString(),
      links: [{ href: `https://api.sandbox.paypal.com/v2/payments/captures/${capId}`, rel: "up", method: "GET" }],
    };
    if (unit) {
      unit.payments.refunds = [...refunds, refund];
      const total = refunded + Number(amount.value);
      cap.status = total >= capTotal - 1e-9 ? "REFUNDED" : "PARTIALLY_REFUNDED";
      const inOrder = unit.payments.captures?.find((c: Json) => c.id === capId);
      if (inOrder) inOrder.status = cap.status;
    }
    return refund;
  }
}

const notFound = (what: string): Json => ({ error: { message: `${what} not found`, type: "paypal_error" } });
