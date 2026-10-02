import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RestPayPalReader, expandOrderFixtures, fixtureTransport, type FixtureResponses } from "@payleash/core";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { buildDisputeFixtures, buildHistory, type HistoryFile } from "../src/history.js";
import { INVOICES, PRODUCTS, planOrders, planRefunds } from "../src/plan.js";
import { runSeed, type PayPalApi, type SeedOptions } from "../src/seed.js";
import { emptyState, StateFile } from "../src/state.js";

type Res = { status: number; body: any };

/** Just enough of PayPal's sandbox: request-id idempotency, card vs wallet orders, capture, refund, invoices. */
class FakePayPal implements PayPalApi {
  posts: { method: string; path: string }[] = [];
  private n = 0;
  private byRequestId = new Map<string, Res>();
  private products = new Set<string>();
  private orders = new Map<string, any>();
  failNext429 = 0;
  constructor(readonly cards = true) {}

  approve(orderId: string, payer = "approver@example.com") {
    const o = this.orders.get(orderId)!;
    o.status = "APPROVED";
    o.payer = { email_address: payer };
  }
  get orderIds() {
    return [...this.orders.keys()];
  }

  async request(method: string, path: string, opts: { body?: any; headers?: Record<string, string> } = {}): Promise<Res> {
    if (method !== "GET") this.posts.push({ method, path });
    if (this.failNext429 > 0 && method !== "GET") {
      this.failNext429--;
      return { status: 429, body: { name: "RATE_LIMIT_REACHED" } };
    }
    const rid = opts.headers?.["PayPal-Request-Id"];
    if (method !== "GET" && rid && this.byRequestId.has(rid)) return this.byRequestId.get(rid)!;
    const res = this.route(method, path, opts.body);
    if (method !== "GET" && rid && res.status < 300) this.byRequestId.set(rid, res);
    return res;
  }

  private route(method: string, path: string, body: any): Res {
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/v1/catalogs/products") {
      if (this.products.has(body.id)) return { status: 409, body: { name: "DUPLICATE_RESOURCE" } };
      this.products.add(body.id);
      return { status: 201, body: { id: body.id } };
    }
    if (method === "POST" && path === "/v2/checkout/orders") {
      const card = !!body.payment_source?.card;
      if (card && !this.cards) return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYMENT_SOURCE_CANNOT_BE_USED" }] } };
      const id = `ORDER${String(++this.n).padStart(12, "0")}`;
      const o = { id, status: card ? "APPROVED" : "PAYER_ACTION_REQUIRED", amount: body.purchase_units[0].amount, links: card ? [] : [{ rel: "payer-action", href: `https://sandbox.paypal.com/checkoutnow?token=${id}` }], payer: card ? { email_address: `card-${this.n % 3}@example.com` } : undefined };
      this.orders.set(id, o);
      return { status: 201, body: o };
    }
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path)) && method === "POST") {
      const o = this.orders.get(m[1]!);
      if (!o) return { status: 404, body: {} };
      if (o.status !== "APPROVED") return { status: 422, body: { name: "ORDER_NOT_APPROVED" } };
      o.status = "COMPLETED";
      o.purchase_units = [{ payments: { captures: [{ id: `CAP${String(++this.n).padStart(12, "0")}`, create_time: "2026-10-02T06:00:00Z" }] } }];
      return { status: 201, body: o };
    }
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path)) && method === "GET") {
      const o = this.orders.get(m[1]!);
      return o ? { status: 200, body: o } : { status: 404, body: {} };
    }
    if ((m = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path)) && method === "POST") return { status: 201, body: { id: `REFUND${String(++this.n).padStart(10, "0")}`, status: "COMPLETED" } };
    if (method === "POST" && path === "/v2/invoicing/invoices") return { status: 201, body: { href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-FAKE-${++this.n}`, rel: "self", method: "GET" } };
    if (method === "POST" && /\/v2\/invoicing\/invoices\/[^/]+\/send$/.test(path)) return { status: 202, body: {} };
    if (method === "GET" && path.startsWith("/v1/customer/disputes")) return { status: 200, body: { items: [] } };
    return { status: 404, body: { name: "NOT_FOUND", path } };
  }
}

const logs: string[] = [];
const opts = (over: Partial<SeedOptions> = {}): SeedOptions => ({ count: 30, mode: "auto", paypalOrders: 3, save: () => {}, log: (l) => logs.push(l), sleep: async () => {}, ...over });
afterEach(() => (logs.length = 0));

describe("seed runner (fake sandbox)", () => {
  it("creates products, captured card orders, partial refunds and invoices", async () => {
    const api = new FakePayPal();
    const st = emptyState();
    await runSeed(api, st, opts());
    expect(Object.keys(st.products)).toHaveLength(PRODUCTS.length);
    expect(Object.values(st.orders).filter((o) => o.stage === "captured")).toHaveLength(30);
    expect(Object.values(st.orders).every((o) => o.captureId && o.buyerEmail && o.total)).toBe(true);
    expect(Object.keys(st.refunds)).toHaveLength(planRefunds(planOrders(30)).length);
    expect(Object.keys(st.invoices)).toHaveLength(INVOICES.length);
    expect(Object.values(st.invoices).filter((i) => i.sent)).toHaveLength(INVOICES.filter((i) => i.send).length);
    expect(st.disputes).toEqual([]);
  });

  it("is idempotent: a second run creates nothing new", async () => {
    const api = new FakePayPal();
    const st = emptyState();
    await runSeed(api, st, opts());
    const before = api.posts.length;
    const snapshot = JSON.stringify(st);
    await runSeed(api, st, opts());
    expect(api.posts.length).toBe(before);
    expect(JSON.stringify(st)).toBe(snapshot);
  });

  it("resumes from the state file and only creates the missing orders when asked for more", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-state-"));
    try {
      const file = new StateFile(dir);
      const api = new FakePayPal();
      await runSeed(api, file.load(), opts({ count: 10, save: (s) => file.save(s) }));
      const first = api.orderIds.length;
      await runSeed(api, file.load(), opts({ count: 25, save: (s) => file.save(s) }));
      expect(first).toBe(10);
      expect(api.orderIds.length).toBe(25);
      expect(Object.values(file.load().orders).filter((o) => o.stage === "captured")).toHaveLength(25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to wallet orders when cards are unavailable, and captures them after a buyer approves (manual step)", async () => {
    const api = new FakePayPal(false);
    const st = emptyState();
    await runSeed(api, st, opts({ count: 30, paypalOrders: 3 }));
    expect(logs.join("\n")).toMatch(/card orders are not available/);
    const waiting = Object.values(st.orders).filter((o) => o.stage === "awaiting_approval");
    expect(waiting).toHaveLength(3); // capped: 200 orders nobody can approve would be useless
    expect(waiting.every((o) => o.approveUrl?.includes("checkoutnow"))).toBe(true);
    expect(st.notes[0]).toMatch(/card probe failed/);

    api.approve(api.orderIds[0]!, "real.buyer@example.com");
    api.approve(api.orderIds[1]!);
    await runSeed(api, st, opts({ count: 30, paypalOrders: 3 }));
    const stages = Object.values(st.orders).map((o) => o.stage);
    expect(stages.filter((s) => s === "captured")).toHaveLength(2);
    expect(stages.filter((s) => s === "awaiting_approval")).toHaveLength(1);
    expect(Object.values(st.orders).find((o) => o.buyerEmail === "real.buyer@example.com")?.captureId).toBeTruthy(); // the real payer is recorded, not the plan's persona
  });

  it("retries rate limits", async () => {
    const api = new FakePayPal();
    api.failNext429 = 2;
    const st = emptyState();
    await runSeed(api, st, opts({ count: 2 }));
    expect(Object.values(st.orders).filter((o) => o.stage === "captured")).toHaveLength(2);
  });
});

describe("plan", () => {
  it("is deterministic and internally consistent", () => {
    expect(planOrders(50)).toEqual(planOrders(50));
    for (const o of planOrders(50)) expect(Number(o.total)).toBeCloseTo(o.items.reduce((a, i) => a + Number(i.unit) * i.qty, 0), 2);
    expect(PRODUCTS.length).toBeGreaterThanOrEqual(3);
    expect(PRODUCTS.length).toBeLessThanOrEqual(5);
    expect(INVOICES).toHaveLength(5);
    for (const r of planRefunds(planOrders(200))) {
      const o = planOrders(200).find((x) => x.key === r.orderKey)!;
      expect(Number(r.value)).toBeLessThan(Number(o.total));
    }
  });
});

describe("offline 90-day history (the sandbox cannot backdate)", () => {
  const dir = resolve(__dirname, "../fixtures");
  const committed = JSON.parse(readFileSync(join(dir, "backtest-history.json"), "utf8")) as HistoryFile;

  it("the committed fixture is exactly what the generator produces (run `pnpm seed -- --history` after changing it)", () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildHistory())));
    expect(JSON.parse(readFileSync(join(dir, "disputes.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(buildDisputeFixtures(buildHistory()))));
  });

  it("has ~200 orders from 3 buyers over 90 days with a few partial refunds", () => {
    expect(committed.orders).toHaveLength(200);
    expect(new Set(committed.orders.map((o) => o.buyer)).size).toBe(3);
    const t = committed.orders.map((o) => new Date(o.createdAt).getTime());
    expect((Math.max(...t) - Math.min(...t)) / 86_400_000).toBeGreaterThan(80);
    expect(committed.orders.filter((o) => o.refunds).length).toBeGreaterThanOrEqual(5);
    expect(new Set(committed.orders.map((o) => o.orderId)).size).toBe(200);
  });

  it("expands into API-shaped responses that core's reader understands (balances, buyers, ages)", async () => {
    const reader = new RestPayPalReader(fixtureTransport(expandOrderFixtures(committed.orders)));
    for (const o of committed.orders) {
      const cap = (await reader.getCapture(o.captureId))!;
      expect(cap.buyerEmail).toBe(o.buyer);
      expect(cap.amount.minor).toBe(Math.round(Number(o.total) * 100));
      const refunded = (o.refunds ?? []).reduce((a, r) => a + Math.round(Number(r.value) * 100), 0);
      expect(cap.remainingMinor).toBe(cap.amount.minor - refunded);
      expect(cap.status).toBe(refunded ? "PARTIALLY_REFUNDED" : "COMPLETED");
    }
  });

  it("dispute fixtures map through the reader, one with an injection attempt", async () => {
    const responses = JSON.parse(readFileSync(join(dir, "disputes.json"), "utf8")) as FixtureResponses;
    const reader = new RestPayPalReader(fixtureTransport(responses));
    const ds = await Promise.all(Object.keys(responses).map((p) => reader.getDispute(p.split("/").pop()!)));
    expect(ds).toHaveLength(3);
    expect(ds.some((d) => d!.messages.some((m) => /ignore previous instructions/i.test(m.content)))).toBe(true);
  });
});

describe("seed-sandbox CLI", () => {
  const run = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const code = await main(argv, { out: (s) => out.push(s), env });
    return { code, text: out.join("\n") };
  };

  it("without credentials it says what to set and exits 0 (so CI does not fail)", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/PAYPAL_CLIENT_ID/);
    expect(r.text).toMatch(/PAYPAL_CLIENT_SECRET/);
    expect(r.text).toMatch(/not an error/);
  });

  it("--dry-run prints the plan and calls nothing", async () => {
    const r = await run(["--dry-run", "--count", "10"]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/products \(4\)/);
    expect(r.text).toMatch(/orders: 10/);
    expect(r.text).toMatch(/invoices \(5\)/);
    expect(r.text).toMatch(/disputes: cannot be created/);
  });

  it("tolerates the literal -- that pnpm forwards", async () => {
    expect((await run(["--", "--dry-run"])).text).toMatch(/products \(4\)/);
  });

  it("refuses a non-sandbox base URL even with credentials, and has no override", async () => {
    const r = await run([], { PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_BASE_URL: "https://api-m.paypal.com" });
    expect(r.code).toBe(3);
    expect(r.text).toMatch(/not the PayPal sandbox/);
    expect(r.text).toMatch(/no live override/);
  });

  it("validates arguments", async () => {
    await expect(run(["--mode", "telepathy"])).rejects.toThrow(/--mode/);
    await expect(run(["--count", "0"])).rejects.toThrow(/--count/);
  });
});
