import { INVOICES, PRODUCTS, planOrders, planRefunds, type PlannedOrder } from "./plan.js";
import type { SeedState } from "./state.js";

export interface PayPalApi {
  request(method: string, path: string, opts?: { body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any }>;
}

export type OrderMode = "auto" | "card" | "paypal";

export interface SeedOptions {
  count: number;
  mode: OrderMode;
  /** In PayPal-wallet mode every order needs a human to approve it, so only this many are created. */
  paypalOrders: number;
  buyers?: readonly string[];
  save: (s: SeedState) => void;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

// PayPal sandbox test card (Visa). Generated cards are also available in the developer dashboard.
const TEST_CARD = { number: "4111111111111111", expiry: "2030-12", security_code: "123" };
const BILLING = { address_line_1: "123 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" };
const ok = (s: number) => s >= 200 && s < 300;
const errText = (r: { status: number; body: any }) => `${r.status} ${r.body?.name ?? ""} ${r.body?.message ?? ""} ${(r.body?.details ?? []).map((d: any) => d.issue).join(",")}`.trim();

/** Retries 429 and 5xx with backoff and paces calls a little so the sandbox is not hammered. */
export function withRetry(api: PayPalApi, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), paceMs = 120): PayPalApi {
  return {
    async request(method, path, opts) {
      for (let attempt = 0; ; attempt++) {
        await sleep(paceMs);
        const r = await api.request(method, path, opts);
        if ((r.status === 429 || r.status >= 500) && attempt < 3) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        return r;
      }
    },
  };
}

const idFromHref = (href?: string) => href?.split("?")[0]?.split("/").filter(Boolean).pop();

export async function seedProducts(api: PayPalApi, st: SeedState, o: SeedOptions): Promise<void> {
  for (const p of PRODUCTS) {
    if (st.products[p.sku]) continue;
    const r = await api.request("POST", "/v1/catalogs/products", {
      headers: { "PayPal-Request-Id": `payleash-seed-product-${p.sku}`, Prefer: "return=representation" },
      body: { id: p.sku, name: p.name, description: p.description, type: p.type, category: p.category },
    });
    if (ok(r.status)) st.products[p.sku] = String(r.body?.id ?? p.sku);
    else if (r.status === 409 || r.status === 422) st.products[p.sku] = p.sku; // already exists from an earlier run
    else o.log(`  product ${p.sku}: ${errText(r)}`);
    o.save(st);
  }
  o.log(`products: ${Object.keys(st.products).length}/${PRODUCTS.length}`);
}

function orderBody(order: PlannedOrder, mode: "card" | "paypal") {
  const items = order.items.map((i) => ({ name: i.name.slice(0, 127), sku: i.sku, quantity: String(i.qty), unit_price: { currency_code: "USD", value: i.unit }, category: "PHYSICAL_GOODS" }));
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: order.key,
        custom_id: order.key,
        description: `PayLeash seed order for ${order.buyer}`,
        amount: { currency_code: "USD", value: order.total, breakdown: { item_total: { currency_code: "USD", value: order.total } } },
        items,
      },
    ],
    payment_source:
      mode === "card"
        ? { card: { name: order.buyer.split("@")[0], ...TEST_CARD, billing_address: BILLING } }
        : { paypal: { experience_context: { payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", return_url: "https://example.com/payleash/return", cancel_url: "https://example.com/payleash/cancel" } } },
  };
}

async function capture(api: PayPalApi, order: PlannedOrder, os: SeedState["orders"][string]): Promise<void> {
  const r = await api.request("POST", `/v2/checkout/orders/${os.orderId}/capture`, { headers: { "PayPal-Request-Id": `payleash-seed-capture-${order.key}`, Prefer: "return=representation" }, body: {} });
  if (!ok(r.status)) {
    os.error = `capture: ${errText(r)}`;
    return;
  }
  absorb(os, r.body);
}

/** Records status, capture id and the real payer email from an order/capture response. */
function absorb(os: SeedState["orders"][string], body: any): void {
  os.status = body?.status ?? os.status;
  const cap = body?.purchase_units?.[0]?.payments?.captures?.[0];
  if (cap?.id) {
    os.captureId = cap.id;
    os.stage = "captured";
    os.capturedAt = cap.create_time ?? new Date().toISOString();
    delete os.error;
  }
  os.buyerEmail = body?.payer?.email_address ?? os.buyerEmail;
  os.approveUrl = body?.links?.find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href ?? os.approveUrl;
}

export async function seedOrders(api: PayPalApi, st: SeedState, o: SeedOptions): Promise<PlannedOrder[]> {
  const plan = planOrders(o.count, o.buyers);
  let mode: "card" | "paypal" = st.orderMode ?? (o.mode === "paypal" ? "paypal" : "card");
  let probed = o.mode !== "auto" || st.orderMode !== undefined;

  for (const order of plan) {
    let os = st.orders[order.key];
    if (os?.stage === "captured") continue;

    // Wallet orders created earlier: capture them if a buyer has approved them since.
    if (os?.orderId && os.stage === "awaiting_approval") {
      const r = await api.request("GET", `/v2/checkout/orders/${os.orderId}`);
      if (ok(r.status) && r.body?.status === "APPROVED") await capture(api, order, os);
      else if (ok(r.status)) absorb(os, r.body);
      o.save(st);
      continue;
    }
    if (mode === "paypal" && Object.values(st.orders).filter((x) => x.orderId).length >= o.paypalOrders) break;

    if (!os?.orderId) {
      const r = await api.request("POST", "/v2/checkout/orders", { headers: { "PayPal-Request-Id": `payleash-seed-order-${order.key}`, Prefer: "return=representation" }, body: orderBody(order, mode) });
      if (!ok(r.status)) {
        if (!probed) {
          // The very first card order failed: this sandbox account cannot take direct card payments.
          o.log(`  card orders are not available on this sandbox account (${errText(r)}).`);
          o.log("  Falling back to PayPal-wallet orders, which a sandbox buyer must approve by hand (see approve links below).");
          st.notes.push(`card probe failed: ${errText(r)}`);
          mode = st.orderMode = "paypal";
          probed = true;
          const r2 = await api.request("POST", "/v2/checkout/orders", { headers: { "PayPal-Request-Id": `payleash-seed-order-${order.key}-w`, Prefer: "return=representation" }, body: orderBody(order, "paypal") });
          if (!ok(r2.status)) {
            st.orders[order.key] = { stage: "failed", error: `create: ${errText(r2)}` };
            o.save(st);
            o.log(`  order ${order.key}: ${errText(r2)}`);
            break;
          }
          os = st.orders[order.key] = { orderId: r2.body.id, stage: "created", total: order.total };
          absorb(os, r2.body);
        } else {
          st.orders[order.key] = { stage: "failed", error: `create: ${errText(r)}` };
          o.save(st);
          o.log(`  order ${order.key}: ${errText(r)}`);
          continue;
        }
      } else {
        os = st.orders[order.key] = { orderId: r.body.id, stage: "created", total: order.total };
        absorb(os, r.body);
      }
      probed = true;
      st.orderMode = mode;
    }

    if (os.stage !== "captured") {
      if (os.status === "PAYER_ACTION_REQUIRED" || (mode === "paypal" && os.status === "CREATED")) os.stage = "awaiting_approval";
      else if (os.status === "APPROVED" || os.status === "CREATED") await capture(api, order, os);
    }
    // Pull the real buyer from PayPal so the manifest reflects the truth, not the plan.
    if (os.stage === "captured" && !os.buyerEmail) {
      const g = await api.request("GET", `/v2/checkout/orders/${os.orderId}`);
      if (ok(g.status)) absorb(os, g.body);
    }
    o.save(st);
    const captured = Object.values(st.orders).filter((x) => x.stage === "captured").length;
    if (captured > 0 && captured % 20 === 0 && os.stage === "captured") o.log(`  orders captured so far: ${captured}`);
  }
  const all = Object.values(st.orders);
  o.log(`orders: ${all.filter((x) => x.stage === "captured").length} captured, ${all.filter((x) => x.stage === "awaiting_approval").length} awaiting buyer approval, ${all.filter((x) => x.stage === "failed").length} failed`);
  return plan;
}

export async function seedRefunds(api: PayPalApi, st: SeedState, plan: PlannedOrder[], o: SeedOptions): Promise<void> {
  for (const rf of planRefunds(plan)) {
    const os = st.orders[rf.orderKey];
    if (st.refunds[rf.key] || os?.stage !== "captured" || !os.captureId) continue;
    const r = await api.request("POST", `/v2/payments/captures/${os.captureId}/refund`, {
      headers: { "PayPal-Request-Id": rf.key, Prefer: "return=representation" },
      body: { amount: { currency_code: "USD", value: rf.value }, note_to_payer: "PayLeash seed: partial refund" },
    });
    if (ok(r.status)) st.refunds[rf.key] = { refundId: r.body.id, captureId: os.captureId, value: rf.value };
    else o.log(`  refund ${rf.key}: ${errText(r)}`);
    o.save(st);
  }
  o.log(`partial refunds: ${Object.keys(st.refunds).length}`);
}

export async function seedInvoices(api: PayPalApi, st: SeedState, o: SeedOptions): Promise<void> {
  for (const inv of INVOICES) {
    let rec = st.invoices[inv.key];
    if (!rec) {
      const r = await api.request("POST", "/v2/invoicing/invoices", {
        headers: { "PayPal-Request-Id": inv.key },
        body: {
          detail: { invoice_number: inv.number, currency_code: "USD", note: "PayLeash demo invoice", memo: inv.key },
          primary_recipients: [{ billing_info: { email_address: inv.recipient, name: { given_name: inv.recipient.split("@")[0], surname: "Sandbox" } } }],
          items: [{ name: inv.description, quantity: "1", unit_amount: { currency_code: "USD", value: inv.amount } }],
        },
      });
      const id = ok(r.status) ? (r.body?.id ?? idFromHref(r.body?.href)) : undefined;
      if (!id) {
        o.log(`  invoice ${inv.number}: ${errText(r)}`);
        continue;
      }
      rec = st.invoices[inv.key] = { invoiceId: id, sent: false };
      o.save(st);
    }
    if (inv.send && !rec.sent) {
      const s = await api.request("POST", `/v2/invoicing/invoices/${rec.invoiceId}/send`, { body: { send_to_recipient: false, send_to_invoicer: false } });
      if (ok(s.status)) rec.sent = true;
      else o.log(`  send ${inv.number}: ${errText(s)}`);
      o.save(st);
    }
  }
  o.log(`invoices: ${Object.keys(st.invoices).length}/${INVOICES.length}`);
}

/** Disputes cannot be opened through the sandbox API. This only lists the ones that exist. */
export async function listDisputes(api: PayPalApi, st: SeedState, o: SeedOptions): Promise<void> {
  const r = await api.request("GET", "/v1/customer/disputes?page_size=20");
  if (!ok(r.status)) {
    o.log(`disputes: could not list (${errText(r)}). Use fixtures/disputes.json.`);
    return;
  }
  st.disputes = (r.body?.items ?? []).map((d: any) => ({ id: d.dispute_id, status: d.status, amount: d.dispute_amount?.value }));
  o.log(`disputes: ${st.disputes.length} existing in the sandbox (the API cannot create them; see README)`);
  o.save(st);
}

export async function runSeed(api: PayPalApi, st: SeedState, o: SeedOptions): Promise<PlannedOrder[]> {
  const a = withRetry(api, o.sleep);
  await seedProducts(a, st, o);
  const plan = await seedOrders(a, st, o);
  await seedRefunds(a, st, plan, o);
  await seedInvoices(a, st, o);
  await listDisputes(a, st, o);
  return plan;
}
