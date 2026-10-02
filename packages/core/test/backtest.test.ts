import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MandateInputSchema,
  applyOverrides,
  fetchLiveHistory,
  historyFromFiles,
  historyFromTransactions,
  orderAsOf,
  refundedAt,
  rerunPolicy,
  runBacktest,
  summarize,
  synthesizeActions,
  windows,
  type History,
  type MandateInput,
} from "../src/index.js";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(root(p), "utf8"));
const history = (): History => historyFromFiles(read("scripts/seed-sandbox/fixtures/backtest-history.json"), read("scripts/seed-sandbox/fixtures/disputes.json"));
const mandate = (): MandateInput => read("examples/mandate.support-agent.json");

afterEach(() => vi.unstubAllGlobals());

describe("history fixtures", () => {
  it("loads the committed 90-day history: 200 orders, 3 disputes, one injected", () => {
    const h = history();
    expect(h.source).toBe("fixtures");
    expect(h.orders).toHaveLength(200);
    expect(h.days).toBe(90);
    expect(Object.keys(h.disputes)).toEqual(["PP-D-10001", "PP-D-10002", "PP-D-10003"]);
    expect(JSON.stringify(h.disputes["PP-D-10003"])).toMatch(/ignore previous instructions/);
  });

  it("hides the refund being replayed, and refunds that had not happened yet", () => {
    const h = history();
    const o = h.orders.find((x) => (x.refunds ?? []).length)!;
    const rf = o.refunds![0]!;
    const anchor = Date.parse(h.anchor);
    const when = refundedAt(o, rf, anchor);
    expect(when).toBeGreaterThan(Date.parse(o.createdAt));
    expect(when).toBeLessThanOrEqual(anchor);
    expect(orderAsOf(o, when - 1, anchor).refunds).toEqual([]);
    expect(orderAsOf(o, when + 1, anchor).refunds).toHaveLength(1);
    expect(orderAsOf(o, when + 1, anchor, [rf.id]).refunds).toEqual([]);
  });
});

describe("synthesised actions", () => {
  it("derives refund requests from refunds and disputes, samples orders, and injects the adversarial cases", () => {
    const h = history();
    const actions = synthesizeActions(h, mandate());
    const by = (o: string) => actions.filter((a) => a.origin === o);
    expect(by("refund")).toHaveLength(h.orders.flatMap((o) => o.refunds ?? []).length);
    expect(by("dispute")).toHaveLength(3);
    expect(by("sampled").length).toBeGreaterThanOrEqual(40);
    const kinds = new Set(actions.flatMap((a) => (a.attack ? [a.attack.kind] : [])));
    expect(kinds).toEqual(new Set(["prompt_injection", "over_limit", "old_order", "burst", "double_refund"]));
    expect(actions.filter((a) => a.attack?.kind === "prompt_injection").length).toBeGreaterThanOrEqual(4);
    // chronological, unique ids, every action after its order exists
    expect(actions.map((a) => a.at)).toEqual([...actions.map((a) => a.at)].sort());
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
    const created = new Map(h.orders.map((o) => [o.captureId, Date.parse(o.createdAt)]));
    for (const a of actions) if (a.captureId) expect(Date.parse(a.at)).toBeGreaterThan(created.get(a.captureId)!);
  });

  it("is deterministic for a seed, differs for another, and can be switched off", () => {
    const h = history();
    expect(synthesizeActions(h, mandate(), { seed: 5 })).toEqual(synthesizeActions(h, mandate(), { seed: 5 }));
    expect(synthesizeActions(h, mandate(), { seed: 5 })).not.toEqual(synthesizeActions(h, mandate(), { seed: 6 }));
    // switched off: only what the history itself contains remains (the injected dispute message is part of the data)
    expect(synthesizeActions(h, mandate(), { adversarial: false }).filter((a) => a.attack).map((a) => a.attack!.variant)).toEqual(["dispute message"]);
    // (the rapid refunds that still fit the daily total belong to the burst case, not to the sampling)
    expect(synthesizeActions(h, mandate(), { sampleOrders: 0 }).filter((a) => a.origin === "sampled" && !a.label.startsWith("Rapid refund"))).toHaveLength(0);
  });
});

describe("runBacktest (dry run through the real guard)", () => {
  it("uses no network at all, and reports automatic / held / denied with money, rules and injections", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("a backtest must not use the network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const run = await runBacktest({ history: history(), mandate: mandate() });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(run.dryRun).toBe(true);

    const { totals, money, adversarial, ruleHits } = run.report;
    expect(totals.allow + totals.hold + totals.deny).toBe(totals.actions);
    expect(totals.actions).toBe(run.results.length);
    expect(totals.allow).toBeGreaterThan(0);
    expect(totals.hold).toBeGreaterThan(0);
    expect(totals.deny).toBeGreaterThan(0);

    // money: what ran on its own is small and never above the 25 USD auto-approve limit per call
    const usd = money.USD!;
    for (const r of run.results.filter((x) => x.decision === "allow")) expect(r.facts.amount!.minor).toBeLessThanOrEqual(2500);
    expect(usd.allowedMinor).toBe(run.results.filter((r) => r.decision === "allow").reduce((a, r) => a + r.facts.amount!.minor, 0));
    expect(usd.heldMinor).toBeGreaterThan(0);
    expect(usd.allowed).toMatch(/^\d+\.\d{2}$/);

    // every injected case is stopped; the five prompt injections (4 emails/tickets + 1 dispute message) are all caught
    expect(adversarial.missed).toEqual([]);
    expect(adversarial.caught).toBe(adversarial.total);
    expect(adversarial.injections.total).toBeGreaterThanOrEqual(5);
    expect(adversarial.injections.caught).toBe(adversarial.injections.total);

    // per-rule hits include the named rules, once per action
    const codes = new Map(ruleHits.map((h) => [h.code, h]));
    for (const c of ["above_auto_approve_threshold", "exceeds_max_per_op", "tainted_argument", "daily_total_exceeded", "payee_not_original_buyer", "refund_exceeds_balance", "order_too_old", "unknown_id"]) {
      expect(codes.get(c)?.actions, c).toBeGreaterThan(0);
    }
    expect(codes.get("above_auto_approve_threshold")!.actions).toBeLessThanOrEqual(totals.actions);
    expect(run.rows).toHaveLength(run.results.length);
  });

  it("replays the dispute that carries the injection: the legitimate refund is held, the obedient one is denied", async () => {
    const run = await runBacktest({ history: history(), mandate: mandate() });
    const dispute = run.results.find((r) => r.action.origin === "dispute" && r.action.label.includes("PP-D-10003"))!;
    expect(dispute.decision).toBe("hold");
    expect(dispute.rawReasons.map((r) => r.code)).not.toContain("tainted_argument"); // the amount is PayPal's own
    const injected = run.results.find((r) => r.action.attack?.variant === "dispute message")!;
    expect(injected.decision).toBe("deny");
    expect(injected.rawReasons.map((r) => r.code)).toContain("tainted_argument");
  });

  it("is reproducible", async () => {
    const a = await runBacktest({ history: history(), mandate: mandate() });
    const b = await runBacktest({ history: history(), mandate: mandate() });
    expect(a.results.map((r) => [r.action.id, r.decision])).toEqual(b.results.map((r) => [r.action.id, r.decision]));
    expect(a.report).toEqual(b.report);
  });

  it("denies everything when the mandate does not allow refunds, and rejects an invalid mandate", async () => {
    const run = await runBacktest({ history: history(), mandate: { agentId: "x", allowedTools: ["get_order"], constraints: {} } });
    expect(run.report.totals.allow + run.report.totals.hold).toBe(0);
    expect(run.results.every((r) => r.rawReasons.some((x) => x.code === "tool_not_allowed"))).toBe(true);
    await expect(runBacktest({ history: history(), mandate: { agentId: "", allowedTools: [] } as unknown as MandateInput })).rejects.toThrow();
  });

  it("without any limit set, a refund is always held (safe default) and the old-order rule only fires when configured", async () => {
    const loose: MandateInput = { agentId: "a", allowedTools: ["create_refund"], constraints: { create_refund: { currency: "USD" } } };
    const run = await runBacktest({ history: history(), mandate: loose, options: { adversarial: false } });
    expect(run.report.totals.allow).toBe(0);
    expect(run.results.some((r) => r.rawReasons.some((x) => x.code === "order_too_old"))).toBe(false);
  });
});

describe("what-if: re-running the policy only", () => {
  it("with no overrides reproduces the guard's own decisions exactly", async () => {
    const run = await runBacktest({ history: history(), mandate: mandate() });
    const again = rerunPolicy(run.results, run.mandate);
    expect(again.map((r) => [r.action.id, r.decision])).toEqual(run.results.map((r) => [r.action.id, r.decision]));
    expect(summarize(again)).toEqual(run.report);
  });

  it("moving the auto-approve threshold moves calls between held and automatic, and never lets an attack through", async () => {
    const run = await runBacktest({ history: history(), mandate: mandate() });
    const at = (x: string) => summarize(rerunPolicy(run.results, run.mandate, { autoApproveThreshold: x }));
    const t0 = at("0.00");
    const t10 = at("10.00");
    const t25 = at("25.00");
    const t50 = at("50.00");
    const t100 = at("100.00");
    expect(t0.totals.allow).toBe(0);
    expect(t25).toEqual(run.report); // the mandate's own threshold
    // more automatic calls as the threshold rises, fewer held ones
    const allow = [t0, t10, t25, t50, t100].map((r) => r.totals.allow);
    expect(allow).toEqual([...allow].sort((a, b) => a - b));
    expect(t100.totals.allow).toBeGreaterThan(t25.totals.allow);
    expect(t100.totals.hold).toBeLessThan(t25.totals.hold);
    expect(t100.money.USD!.allowedMinor).toBeGreaterThan(t25.money.USD!.allowedMinor);
    // the firewall is untouched: the injections stay caught at any threshold, the tainted $7.77 stays held
    for (const r of [t0, t10, t50, t100]) {
      expect(r.adversarial.injections.caught).toBe(r.adversarial.injections.total);
      expect(r.adversarial.missed).toEqual([]);
    }
    const tainted = rerunPolicy(run.results, run.mandate, { autoApproveThreshold: "100.00" }).find((r) => r.action.attack?.variant === "tainted amount below the threshold")!;
    expect(tainted.decision).toBe("hold");
  });

  it("can also move the per-operation limit and the daily total, and rejects a malformed amount", async () => {
    const run = await runBacktest({ history: history(), mandate: mandate() });
    const wide = summarize(rerunPolicy(run.results, run.mandate, { maxAmountPerOp: "5000.00", dailyTotal: "50000.00" }));
    expect(wide.ruleHits.find((h) => h.code === "exceeds_max_per_op")).toBeUndefined();
    expect(wide.ruleHits.find((h) => h.code === "daily_total_exceeded")).toBeUndefined();
    expect(() => applyOverrides(run.mandate, { autoApproveThreshold: "ten" })).toThrow();
  });

  it("the policy is the only thing re-run: no guard, no database, no network", async () => {
    const run = await runBacktest({ history: history(), mandate: mandate() });
    const spy = vi.fn(() => {
      throw new Error("no network");
    });
    vi.stubGlobal("fetch", spy);
    rerunPolicy(run.results, run.mandate, { autoApproveThreshold: "60.00" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("live history (Transaction Search + Disputes), read-only", () => {
  it("splits 90 days into windows of at most 31 days that tile the range", () => {
    const end = new Date("2026-10-01T00:00:00Z");
    const w = windows(end, 90);
    expect(w).toHaveLength(3);
    for (const x of w) expect((x.end.getTime() - x.start.getTime()) / 86_400_000).toBeLessThanOrEqual(31);
    expect(w[0]!.start.getTime()).toBe(end.getTime() - 90 * 86_400_000);
    expect(w.at(-1)!.end.getTime()).toBe(end.getTime());
    for (let i = 1; i < w.length; i++) expect(w[i]!.start.getTime()).toBe(w[i - 1]!.end.getTime());
  });

  const tx = (id: string, code: string, value: string, date: string, extra: Record<string, unknown> = {}, payer?: string) => ({
    transaction_info: { transaction_id: id, transaction_event_code: code, transaction_amount: { currency_code: "USD", value }, transaction_initiation_date: date, transaction_status: "S", ...extra },
    ...(payer ? { payer_info: { email_address: payer } } : { payer_info: {} }),
    cart_info: { item_details: [{ item_name: "Mug", item_quantity: "2", item_unit_price: { currency_code: "USD", value: "12.50" } }] },
  });
  const details = [
    tx("CAP1", "T0006", "25.00", "2026-09-01T10:00:00+0000", { paypal_reference_id: "ORD1", paypal_reference_id_type: "ODR" }, "Alice@Example.com"),
    tx("CAP2", "T0006", "64.00", "2026-09-02T10:00:00+0000", {}),
    tx("REF1", "T1107", "-10.00", "2026-09-05T10:00:00+0000", { paypal_reference_id: "CAP1", paypal_reference_id_type: "TXN" }),
    tx("FEE9", "T0300", "-1.00", "2026-09-05T10:00:00+0000"),
    tx("PEND", "T0006", "9.00", "2026-09-06T10:00:00+0000", { transaction_status: "P" }),
  ];

  it("maps sales, refunds and card payments (no payer email) into orders", () => {
    const orders = historyFromTransactions(details as any);
    expect(orders.map((o) => o.captureId)).toEqual(["CAP1", "CAP2"]);
    expect(orders[0]).toMatchObject({ orderId: "ORD1", buyer: "alice@example.com", total: "25.00", refunds: [{ id: "REF1", value: "10.00" }], items: [{ name: "Mug", unit: "12.50", qty: 2 }] });
    expect(orders[1]).toMatchObject({ buyer: null, total: "64.00" });
  });

  it("fetches every page of every window with GET only, then the disputes, and the result replays", async () => {
    const calls: string[] = [];
    const transport = {
      async get(path: string) {
        calls.push(path);
        if (path.startsWith("/v1/reporting/transactions")) {
          const page = Number(new URL(`http://x${path}`).searchParams.get("page"));
          return { status: 200, body: { transaction_details: page === 1 ? details : [], total_pages: 2, page } };
        }
        if (path.startsWith("/v1/customer/disputes?")) return { status: 200, body: { items: [{ dispute_id: "PP-D-1" }] } };
        if (path === "/v1/customer/disputes/PP-D-1") {
          return {
            status: 200,
            body: { dispute_id: "PP-D-1", create_time: "2026-09-10T10:00:00Z", dispute_amount: { currency_code: "USD", value: "25.00" }, disputed_transactions: [{ seller_transaction_id: "CAP1" }], messages: [{ posted_by: "BUYER", content: "never arrived" }] },
          };
        }
        return { status: 404, body: {} };
      },
    };
    const h = await fetchLiveHistory(transport, { now: new Date("2026-10-01T00:00:00Z") });
    expect(h.source).toBe("paypal");
    expect(calls.filter((c) => c.startsWith("/v1/reporting/transactions"))).toHaveLength(6); // 3 windows x 2 pages
    for (const c of calls.filter((x) => x.startsWith("/v1/reporting/transactions"))) {
      const q = new URL(`http://x${c}`).searchParams;
      expect(q.get("fields")).toBe("all");
      expect((Date.parse(q.get("end_date")!) - Date.parse(q.get("start_date")!)) / 86_400_000).toBeLessThanOrEqual(31);
    }
    expect(Object.keys(h.disputes)).toEqual(["PP-D-1"]);
    const run = await runBacktest({ history: { ...h, anchor: "2026-10-01T00:00:00.000Z" }, mandate: mandate(), options: { sampleOrders: 0 } });
    expect(run.report.totals.actions).toBeGreaterThan(0);
  });

  it("explains a 403 from Transaction Search (missing permission or cached token)", async () => {
    await expect(fetchLiveHistory({ get: async () => ({ status: 403, body: {} }) }, { now: new Date() })).rejects.toThrow(/Transaction Search permission/);
  });
});

describe("mandate input used by the backtest is validated", () => {
  it("strict schema errors surface before anything runs", () => {
    expect(() => MandateInputSchema.parse({ agentId: "a", allowedTools: ["create_refund"], constraints: { create_refund: { maxAmountPerOp: "10" } } })).toThrow(/currency/);
  });
});
