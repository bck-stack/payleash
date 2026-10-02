import { MoneyError, money, type Money } from "../money.js";
import { PayPalReadError, type CaptureTruth, type DisputeTruth, type InvoiceTruth, type KnownFigure, type OrderTruth, type PayPalReader, type SubscriptionTruth } from "./types.js";

export interface PayPalTransport {
  get(path: string): Promise<{ status: number; body: unknown }>;
}

type Json = Record<string, any>;

const asMoney = (m: any): Money | undefined => {
  if (!m || typeof m.value !== "string" || typeof m.currency_code !== "string") return undefined;
  try {
    return money(m.value, m.currency_code);
  } catch (e) {
    if (e instanceof MoneyError) return undefined;
    throw e;
  }
};
const asDate = (s: unknown): Date | undefined => {
  if (typeof s !== "string") return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const lastSegment = (href: unknown): string | undefined => (typeof href === "string" ? href.split("?")[0]!.split("/").filter(Boolean).pop() : undefined);
const link = (body: Json, rel: string): string | undefined => (body.links as Json[] | undefined)?.find((l) => l.rel === rel)?.href;
const lower = (s: unknown): string | undefined => (typeof s === "string" && s.trim() ? s.trim().toLowerCase() : undefined);

/** Order line items and shipping/tax totals: amounts PayPal itself shows for the order. */
function unitFigures(unit: Json | undefined): KnownFigure[] {
  if (!unit) return [];
  const out: KnownFigure[] = [];
  const total = asMoney(unit.amount);
  if (total) out.push({ label: "order total", money: total });
  for (const [key, label] of [["shipping", "shipping"], ["tax_total", "tax"], ["item_total", "items"]] as const) {
    const m = asMoney(unit.amount?.breakdown?.[key]);
    if (m && m.minor > 0) out.push({ label, money: m });
  }
  for (const item of (unit.items as Json[] | undefined) ?? []) {
    const unit_price = asMoney(item.unit_price);
    const qty = Number(item.quantity ?? 1);
    if (unit_price && Number.isInteger(qty) && qty > 0) {
      out.push({ label: `item "${String(item.name ?? "item").slice(0, 40)}"`, money: { currency: unit_price.currency, minor: unit_price.minor * qty } });
    }
  }
  return out;
}

/**
 * Maps PayPal REST responses (Payments v2, Orders v2, Disputes v1, Invoicing v2, Subscriptions v1)
 * into ground-truth objects. The transport is pluggable: HTTP in production, recorded JSON in tests.
 */
export class RestPayPalReader implements PayPalReader {
  constructor(private readonly transport: PayPalTransport) {}

  private async fetch(path: string): Promise<Json | null> {
    const res = await this.transport.get(path);
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new PayPalReadError(`PayPal GET ${path} failed with status ${res.status}`, res.status);
    }
    return (res.body ?? {}) as Json;
  }

  async getCapture(id: string): Promise<CaptureTruth | null> {
    const cap = await this.fetch(`/v2/payments/captures/${encodeURIComponent(id)}`);
    if (!cap) return null;
    const amount = asMoney(cap.amount);
    if (!amount) throw new PayPalReadError(`capture ${id} has no readable amount`);

    // The capture links up to its order, which is where the buyer and the refunds are visible.
    const orderId = lastSegment(link(cap, "up"));
    const order = orderId ? await this.fetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}`) : null;
    const unit = (order?.purchase_units as Json[] | undefined)?.find((u) => (u.payments?.captures as Json[] | undefined)?.some((c) => c.id === id));

    let refundedMinor: number | undefined;
    if (unit) {
      const refunds = ((unit.payments?.refunds as Json[] | undefined) ?? []).filter((r) => {
        const up = lastSegment(link(r, "up"));
        const sole = ((unit.payments?.captures as Json[]) ?? []).length === 1;
        return up ? up === id : sole;
      });
      refundedMinor = refunds
        .filter((r) => r.status !== "FAILED" && r.status !== "CANCELLED")
        .reduce((sum, r) => sum + (asMoney(r.amount)?.minor ?? 0), 0);
    } else if (cap.status === "REFUNDED") {
      refundedMinor = amount.minor;
    } else if (cap.status === "COMPLETED" || cap.status === "PENDING") {
      refundedMinor = 0;
    }
    const remainingMinor = refundedMinor === undefined ? undefined : Math.max(0, amount.minor - refundedMinor);

    const figures: KnownFigure[] = [{ label: "captured amount", money: amount }];
    if (remainingMinor !== undefined) figures.push({ label: "remaining refundable", money: { currency: amount.currency, minor: remainingMinor } });
    figures.push(...unitFigures(unit));

    return {
      id: String(cap.id ?? id),
      status: String(cap.status ?? "UNKNOWN"),
      amount,
      refundedMinor,
      remainingMinor,
      createdAt: asDate(cap.create_time),
      orderId,
      buyerEmail: lower(order?.payer?.email_address),
      figures,
    };
  }

  async getOrder(id: string): Promise<OrderTruth | null> {
    const o = await this.fetch(`/v2/checkout/orders/${encodeURIComponent(id)}`);
    if (!o) return null;
    const units = (o.purchase_units as Json[] | undefined) ?? [];
    return {
      id: String(o.id ?? id),
      status: String(o.status ?? "UNKNOWN"),
      amount: asMoney(units[0]?.amount),
      createdAt: asDate(o.create_time),
      buyerEmail: lower(o.payer?.email_address),
      captureIds: units.flatMap((u) => ((u.payments?.captures as Json[] | undefined) ?? []).map((c) => String(c.id))),
      figures: units.flatMap(unitFigures),
    };
  }

  async getDispute(id: string): Promise<DisputeTruth | null> {
    const d = await this.fetch(`/v1/customer/disputes/${encodeURIComponent(id)}`);
    if (!d) return null;
    const tx = (d.disputed_transactions as Json[] | undefined)?.[0];
    return {
      id: String(d.dispute_id ?? id),
      status: String(d.status ?? "UNKNOWN"),
      amount: asMoney(d.dispute_amount) ?? asMoney(tx?.gross_amount),
      createdAt: asDate(d.create_time),
      buyerEmail: lower(tx?.buyer?.email ?? tx?.buyer?.email_address),
      messages: ((d.messages as Json[] | undefined) ?? []).filter((m) => typeof m.content === "string").map((m) => ({ postedBy: m.posted_by, content: m.content })),
    };
  }

  async getInvoice(id: string): Promise<InvoiceTruth | null> {
    const inv = await this.fetch(`/v2/invoicing/invoices/${encodeURIComponent(id)}`);
    if (!inv) return null;
    const amount = asMoney(inv.amount);
    const paid = asMoney(inv.payments?.paid_amount);
    const recipients = ((inv.primary_recipients as Json[] | undefined) ?? [])
      .map((r) => lower(r.billing_info?.email_address))
      .filter((e): e is string => !!e);
    const figures: KnownFigure[] = [];
    if (amount) figures.push({ label: "invoice total", money: amount });
    const due = asMoney(inv.due_amount);
    if (due) figures.push({ label: "amount due", money: due });
    return {
      id: String(inv.id ?? id),
      status: String(inv.status ?? "UNKNOWN"),
      amount,
      paidMinor: paid?.minor,
      createdAt: asDate(inv.detail?.metadata?.create_time),
      recipients,
      figures,
    };
  }

  async getSubscription(id: string): Promise<SubscriptionTruth | null> {
    const s = await this.fetch(`/v1/billing/subscriptions/${encodeURIComponent(id)}`);
    if (!s) return null;
    return {
      id: String(s.id ?? id),
      status: String(s.status ?? "UNKNOWN"),
      subscriberEmail: lower(s.subscriber?.email_address),
      planId: typeof s.plan_id === "string" ? s.plan_id : undefined,
      createdAt: asDate(s.create_time),
    };
  }
}
