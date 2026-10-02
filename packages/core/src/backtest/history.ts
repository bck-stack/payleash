import type { OrderFixtureSpec } from "../paypal/fixtures.js";
import type { PayPalTransport } from "../paypal/rest-reader.js";

/**
 * A transaction history in PayPal's own shapes: orders as `OrderFixtureSpec` (they expand into raw Orders v2 /
 * Payments v2 responses with `orderFixtures`) and disputes as raw `GET /v1/customer/disputes/:id` bodies.
 * It comes from a fixture file (the sandbox cannot backdate orders) or from PayPal's Transaction Search and
 * Disputes APIs; the backtest treats both alike.
 */
export interface History {
  source: "fixtures" | "paypal";
  /** The end of the window: "today" for the replay. */
  anchor: string;
  days: number;
  orders: OrderFixtureSpec[];
  /** Raw dispute bodies keyed by dispute id. */
  disputes: Record<string, any>;
}

export interface HistoryFileShape {
  meta?: { anchor?: string; days?: number };
  orders: OrderFixtureSpec[];
}

/** `scripts/seed-sandbox/fixtures/backtest-history.json` (+ optional `disputes.json`, a map of path -> raw body). */
export function historyFromFiles(history: HistoryFileShape, disputes: Record<string, unknown> = {}): History {
  if (!Array.isArray(history.orders)) throw new Error("history file has no `orders` array");
  const anchor = history.meta?.anchor ?? new Date(Math.max(...history.orders.map((o) => Date.parse(o.createdAt)))).toISOString();
  const byId: Record<string, any> = {};
  for (const [path, body] of Object.entries(disputes)) {
    const id = (body as any)?.dispute_id ?? path.split("/").pop();
    if (typeof id === "string") byId[id] = body;
  }
  return { source: "fixtures", anchor, days: history.meta?.days ?? 90, orders: history.orders, disputes: byId };
}

// ---------------------------------------------------------------------------
// Live data: Transaction Search (/v1/reporting/transactions) + Disputes (/v1/customer/disputes)
// ---------------------------------------------------------------------------

type Json = Record<string, any>;
const DAY = 86_400_000;
/** Transaction Search accepts at most 31 days per request. */
export const MAX_WINDOW_DAYS = 31;

const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const abs = (v: unknown): string | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.abs(n).toFixed(2) : undefined;
};

export function windows(end: Date, days: number, windowDays = MAX_WINDOW_DAYS): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  let hi = end.getTime();
  const lo = end.getTime() - days * DAY;
  while (hi > lo) {
    const start = Math.max(lo, hi - windowDays * DAY);
    out.push({ start: new Date(start), end: new Date(hi) });
    hi = start;
  }
  return out.reverse();
}

/**
 * Maps `transaction_details` of Transaction Search into orders with their refunds.
 * Payments are the positive, successful sale events; refunds (event T1107) point back at the original payment
 * through `paypal_reference_id`. Card payments carry no payer email: `buyer` is then null, as in the order itself.
 */
export function historyFromTransactions(details: Json[]): OrderFixtureSpec[] {
  const orders = new Map<string, OrderFixtureSpec>();
  const refunds: { captureId: string; id: string; value: string; createdAt: string }[] = [];
  for (const d of details) {
    const t = d.transaction_info as Json | undefined;
    if (!t?.transaction_id) continue;
    const code = String(t.transaction_event_code ?? "");
    const value = abs(t.transaction_amount?.value);
    const created = typeof t.transaction_initiation_date === "string" ? t.transaction_initiation_date : undefined;
    if (!value || !created) continue;
    if (code === "T1107") {
      const ref = String(t.paypal_reference_id ?? "");
      if (ref) refunds.push({ captureId: ref, id: String(t.transaction_id), value, createdAt: created });
      continue;
    }
    const isSale = code.startsWith("T00") && Number(t.transaction_amount?.value) > 0 && (t.transaction_status === undefined || t.transaction_status === "S");
    if (!isSale) continue;
    const items = ((d.cart_info?.item_details as Json[] | undefined) ?? [])
      .map((i) => ({ name: String(i.item_name ?? "Item").slice(0, 80), unit: abs(i.item_unit_price?.value) ?? value, qty: Number.parseInt(String(i.item_quantity ?? "1"), 10) || 1 }))
      .filter((i) => Number(i.unit) > 0);
    const orderRef = t.paypal_reference_id_type === "ODR" && t.paypal_reference_id ? String(t.paypal_reference_id) : `ORD-${t.transaction_id}`;
    orders.set(String(t.transaction_id), {
      orderId: orderRef,
      captureId: String(t.transaction_id),
      buyer: typeof d.payer_info?.email_address === "string" && d.payer_info.email_address ? d.payer_info.email_address.toLowerCase() : null,
      total: value,
      currency: String(t.transaction_amount?.currency_code ?? "USD"),
      createdAt: created,
      ...(items.length ? { items } : {}),
    });
  }
  for (const r of refunds) {
    const o = orders.get(r.captureId);
    if (o) (o.refunds ??= []).push({ id: r.id, value: r.value, createdAt: r.createdAt });
  }
  return [...orders.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export interface LiveHistoryOptions {
  /** End of the window; default now. */
  now?: Date;
  days?: number;
  /** Safety valve for very busy accounts. */
  maxPagesPerWindow?: number;
  maxDisputes?: number;
}

/** Reads the last N days (default 90) in 31-day windows. Read-only: only GET requests are made. */
export async function fetchLiveHistory(transport: PayPalTransport, o: LiveHistoryOptions = {}): Promise<History> {
  const now = o.now ?? new Date();
  const days = o.days ?? 90;
  const details: Json[] = [];
  for (const w of windows(now, days)) {
    for (let page = 1; page <= (o.maxPagesPerWindow ?? 20); page++) {
      const qs = new URLSearchParams({ start_date: isoSec(w.start), end_date: isoSec(w.end), fields: "all", page_size: "500", page: String(page) });
      const res = await transport.get(`/v1/reporting/transactions?${qs}`);
      if (res.status < 200 || res.status >= 300) throw new Error(`PayPal Transaction Search failed with status ${res.status}${res.status === 403 ? " (the app lacks the Transaction Search permission, or PayPal still serves a cached token: see docs/SMOKE-TEST.md)" : ""}`);
      const body = (res.body ?? {}) as Json;
      details.push(...((body.transaction_details as Json[] | undefined) ?? []));
      if (page >= Number(body.total_pages ?? 1)) break;
    }
  }
  const disputes: Record<string, any> = {};
  const start = new Date(now.getTime() - days * DAY);
  const list = await transport.get(`/v1/customer/disputes?${new URLSearchParams({ start_time: isoSec(start), page_size: "50" })}`);
  if (list.status >= 200 && list.status < 300) {
    for (const item of ((list.body as Json)?.items as Json[] | undefined)?.slice(0, o.maxDisputes ?? 50) ?? []) {
      const id = String(item.dispute_id ?? "");
      if (!id) continue;
      const full = await transport.get(`/v1/customer/disputes/${encodeURIComponent(id)}`);
      disputes[id] = full.status === 200 ? full.body : item;
    }
  }
  return { source: "paypal", anchor: now.toISOString(), days, orders: historyFromTransactions(details), disputes };
}
