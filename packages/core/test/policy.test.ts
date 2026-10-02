import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  SqlitePolicyStore,
  SqliteReplayGuard,
  evaluatePolicy,
  money,
  openDb,
  type Decision,
  type FreezeState,
  type Mandate,
  type OperationFacts,
  type PolicyStore,
  type ToolConstraints,
} from "../src/index.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS);

function mandate(constraints: ToolConstraints | undefined, over: Partial<Mandate> = {}): Mandate {
  return {
    id: "mnd_1",
    issuer: "owner",
    agentId: "agent-1",
    allowedTools: ["create_refund", "get_order"],
    constraints: constraints ? { create_refund: constraints } : {},
    notBefore: nowSec - 3600,
    expiresAt: nowSec + 3600,
    ...over,
  };
}

class FakeStore implements PolicyStore {
  constructor(
    private readonly freeze: FreezeState = { frozen: false },
    private readonly spent = 0,
  ) {}
  freezeState(): FreezeState {
    return this.freeze;
  }
  spentSince(): number {
    return this.spent;
  }
}

interface Case {
  name: string;
  constraints?: ToolConstraints;
  mandate?: Partial<Mandate>;
  tool?: string;
  facts?: OperationFacts;
  amountBearing?: boolean;
  spent?: number; // minor units
  freeze?: FreezeState;
  decision: Decision;
  codes: string[]; // exact set of reason codes (order-insensitive)
}

const usd = (v: string) => money(v, "USD");
const base: ToolConstraints = {
  currency: "USD",
  maxAmountPerOp: "100.00",
  dailyTotal: "300.00",
  autoApproveThreshold: "25.00",
  payeeMustBeOriginalBuyer: true,
  orderAgeDays: 60,
};
const goodFacts = (amount: string): OperationFacts => ({
  amount: usd(amount),
  originalBuyerEmail: "alice@example.com",
  transactionTime: daysAgo(5),
});

const cases: Case[] = [
  // --- happy path -------------------------------------------------------
  { name: "small refund within every limit is allowed", constraints: base, facts: goodFacts("10.00"), decision: "allow", codes: [] },
  { name: "exactly at the auto-approve threshold is allowed", constraints: base, facts: goodFacts("25.00"), decision: "allow", codes: [] },
  { name: "declared payee equal to buyer (case-insensitive) is allowed", constraints: base, facts: { ...goodFacts("10.00"), payeeEmail: "ALICE@example.com " }, decision: "allow", codes: [] },

  // --- allowed tools ----------------------------------------------------
  { name: "tool outside the allow-list is denied", constraints: base, tool: "cancel_subscription", facts: {}, decision: "deny", codes: ["tool_not_allowed"] },

  // --- auto-approve threshold -------------------------------------------
  { name: "above threshold but within max is held", constraints: base, facts: goodFacts("25.01"), decision: "hold", codes: ["above_auto_approve_threshold"] },
  { name: "no threshold at all: amount-bearing money call is held", constraints: { currency: "USD", maxAmountPerOp: "100.00" }, facts: goodFacts("1.00"), amountBearing: true, decision: "hold", codes: ["no_auto_approve_threshold"] },
  { name: "no constraints and no threshold: still held for a human", constraints: undefined, tool: "create_refund", facts: { amount: usd("1.00") }, amountBearing: true, decision: "hold", codes: ["no_auto_approve_threshold"] },
  { name: "non-amount tool without constraints is allowed", constraints: undefined, tool: "get_order", mandate: { allowedTools: ["get_order"] }, facts: {}, decision: "allow", codes: [] },

  // --- max amount per op ------------------------------------------------
  { name: "above per-op max is denied (and not merely held)", constraints: base, facts: goodFacts("100.01"), decision: "deny", codes: ["exceeds_max_per_op", "above_auto_approve_threshold"] },
  { name: "exactly at per-op max is held (threshold) not denied", constraints: base, facts: goodFacts("100.00"), decision: "hold", codes: ["above_auto_approve_threshold"] },

  // --- rolling daily total ----------------------------------------------
  { name: "daily total: would reach exactly the limit is allowed", constraints: { ...base, autoApproveThreshold: "100.00" }, facts: goodFacts("100.00"), spent: 20000, decision: "allow", codes: [] },
  { name: "daily total: one cent over is denied", constraints: { ...base, autoApproveThreshold: "100.00" }, facts: goodFacts("100.01"), spent: 20000, decision: "deny", codes: ["daily_total_exceeded", "exceeds_max_per_op", "above_auto_approve_threshold"] },
  { name: "daily total: budget used up denies even a tiny refund", constraints: base, facts: goodFacts("1.00"), spent: 30000, decision: "deny", codes: ["daily_total_exceeded"] },

  // --- currency ---------------------------------------------------------
  { name: "other currency is denied", constraints: base, facts: { ...goodFacts("5.00"), amount: money("5.00", "EUR") }, decision: "deny", codes: ["currency_mismatch"] },

  // --- payee must equal original buyer ----------------------------------
  { name: "payee is not the buyer: denied", constraints: base, facts: { ...goodFacts("5.00"), payeeEmail: "attacker@example.com" }, decision: "deny", codes: ["payee_not_original_buyer"] },
  { name: "payee declared but buyer unknown: held", constraints: base, facts: { ...goodFacts("5.00"), originalBuyerEmail: undefined, payeeEmail: "alice@example.com" }, decision: "hold", codes: ["payee_unverifiable"] },
  { name: "no payee declared means implicit buyer: allowed", constraints: base, facts: { ...goodFacts("5.00"), originalBuyerEmail: undefined }, decision: "allow", codes: [] },
  { name: "payee check is off when the mandate does not ask for it", constraints: { ...base, payeeMustBeOriginalBuyer: false }, facts: { ...goodFacts("5.00"), payeeEmail: "other@example.com" }, decision: "allow", codes: [] },

  // --- order age window -------------------------------------------------
  { name: "order exactly at the age limit is allowed", constraints: base, facts: { ...goodFacts("5.00"), transactionTime: daysAgo(60) }, decision: "allow", codes: [] },
  { name: "order older than the window is denied", constraints: base, facts: { ...goodFacts("5.00"), transactionTime: daysAgo(61) }, decision: "deny", codes: ["order_too_old"] },
  { name: "age limit set but order time unknown: held", constraints: base, facts: { ...goodFacts("5.00"), transactionTime: undefined }, decision: "hold", codes: ["order_age_unverifiable"] },

  // --- amount unknown ---------------------------------------------------
  { name: "amount-bearing call with unknown amount is held", constraints: base, facts: { originalBuyerEmail: "alice@example.com", transactionTime: daysAgo(1) }, amountBearing: true, decision: "hold", codes: ["amount_unknown"] },

  // --- combinations -----------------------------------------------------
  { name: "deny dominates hold: old order + above threshold", constraints: base, facts: { ...goodFacts("50.00"), transactionTime: daysAgo(90) }, decision: "deny", codes: ["order_too_old", "above_auto_approve_threshold"] },
  { name: "all violations at once are all reported", constraints: base, facts: { ...goodFacts("999.00"), payeeEmail: "attacker@example.com", transactionTime: daysAgo(400) }, spent: 10000, decision: "deny", codes: ["payee_not_original_buyer", "order_too_old", "exceeds_max_per_op", "daily_total_exceeded", "above_auto_approve_threshold"] },
  { name: "two holds stay a hold", constraints: base, facts: { ...goodFacts("50.00"), originalBuyerEmail: undefined, payeeEmail: "alice@example.com" }, decision: "hold", codes: ["payee_unverifiable", "above_auto_approve_threshold"] },

  // --- mandate validity (defence in depth) ------------------------------
  { name: "expired mandate is denied", constraints: base, mandate: { expiresAt: nowSec }, facts: goodFacts("5.00"), decision: "deny", codes: ["mandate_expired"] },
  { name: "not-yet-valid mandate is denied", constraints: base, mandate: { notBefore: nowSec + 1 }, facts: goodFacts("5.00"), decision: "deny", codes: ["mandate_not_yet_valid"] },

  // --- kill switch ------------------------------------------------------
  { name: "global freeze denies a perfectly good call", constraints: base, facts: goodFacts("1.00"), freeze: { frozen: true, scope: "global", reason: "incident" }, decision: "deny", codes: ["frozen_global"] },
  { name: "per-agent freeze denies a perfectly good call", constraints: base, facts: goodFacts("1.00"), freeze: { frozen: true, scope: "agent" }, decision: "deny", codes: ["frozen_agent"] },
  { name: "freeze beats an unlisted tool: only the freeze is reported", constraints: base, tool: "cancel_subscription", facts: {}, freeze: { frozen: true, scope: "global" }, decision: "deny", codes: ["frozen_global"] },
];

describe("policy evaluator (table driven)", () => {
  it.each(cases)("$name", (c) => {
    const result = evaluatePolicy(
      mandate(c.constraints, c.mandate),
      { tool: c.tool ?? "create_refund", args: {} },
      { now: NOW, facts: c.facts ?? {}, store: new FakeStore(c.freeze, c.spent), amountBearing: c.amountBearing ?? (c.tool ?? "create_refund") === "create_refund" },
    );
    expect(result.decision).toBe(c.decision);
    expect(result.reasons.map((r) => r.code).sort()).toEqual([...c.codes].sort());
    for (const r of result.reasons) expect(r.message.length).toBeGreaterThan(10);
  });

  it("is deterministic: same input, same output", () => {
    const run = () => evaluatePolicy(mandate(base), { tool: "create_refund", args: {} }, { now: NOW, facts: goodFacts("50.00"), store: new FakeStore(), amountBearing: true });
    expect(run()).toEqual(run());
  });

  it("covers every reason code the evaluator can emit", () => {
    const emitted = new Set(cases.flatMap((c) => c.codes));
    for (const code of [
      "frozen_global", "frozen_agent", "mandate_expired", "mandate_not_yet_valid", "tool_not_allowed", "currency_mismatch",
      "payee_not_original_buyer", "payee_unverifiable", "order_too_old", "order_age_unverifiable", "exceeds_max_per_op",
      "daily_total_exceeded", "above_auto_approve_threshold", "no_auto_approve_threshold", "amount_unknown",
    ]) expect(emitted, code).toContain(code);
  });
});

describe("SqlitePolicyStore", () => {
  it("rolls a 24h window and ignores released reservations", () => {
    const db = openDb(":memory:");
    const store = new SqlitePolicyStore(db);
    const t0 = new Date("2026-10-01T00:00:00Z");
    const mk = (amt: string, at: Date) => store.reserve({ agentId: "a", tool: "create_refund", amount: money(amt, "USD"), callHash: "h", now: at })!;

    const r1 = mk("100.00", t0);
    store.commit(r1, "REFUND1");
    const r2 = mk("50.00", new Date(t0.getTime() + 3600_000));
    store.release(r2); // failed execution frees the budget
    mk("10.00", new Date(t0.getTime() + 2 * 3600_000));

    const at = (h: number) => new Date(t0.getTime() + h * 3600_000).getTime();
    expect(store.spentSince("a", "create_refund", "USD", at(3) - DAY_MS)).toBe(11000);
    // 25h later the first refund has rolled out of the window
    expect(store.spentSince("a", "create_refund", "USD", at(25) - DAY_MS)).toBe(1000); // only the 10.00 refund (hour 2) is still inside the window
    // other agents / tools / currencies are separate budgets
    expect(store.spentSince("b", "create_refund", "USD", 0)).toBe(0);
    expect(store.spentSince("a", "pay_order", "USD", 0)).toBe(0);
    expect(store.spentSince("a", "create_refund", "EUR", 0)).toBe(0);
    expect(store.summary("a", new Date(t0.getTime() + 3 * 3600_000))).toEqual([{ tool: "create_refund", currency: "USD", operations: 2, totalMinor: 11000 }]);
  });

  it("reserve() refuses to overshoot the daily limit (atomic check)", () => {
    const store = new SqlitePolicyStore(openDb(":memory:"));
    const args = { agentId: "a", tool: "create_refund", amount: money("60.00", "USD"), callHash: "h", dailyLimitMinor: 10000, now: NOW };
    expect(store.reserve(args)).not.toBeNull();
    expect(store.reserve(args)).toBeNull(); // 60 + 60 > 100
    expect(store.spentSince("a", "create_refund", "USD", 0)).toBe(6000);
  });

  it("kill switch: global and per agent, with lift", () => {
    const store = new SqlitePolicyStore(openDb(":memory:"));
    expect(store.freezeState("a")).toEqual({ frozen: false });
    store.freeze({ agentId: "a" }, "suspicious");
    expect(store.freezeState("a")).toEqual({ frozen: true, scope: "agent", reason: "suspicious" });
    expect(store.freezeState("b")).toEqual({ frozen: false });
    store.freeze({}, "incident");
    expect(store.freezeState("b")).toMatchObject({ frozen: true, scope: "global" });
    expect(store.freezeState("a")).toMatchObject({ scope: "global" });
    expect(store.unfreeze({})).toBe(true);
    expect(store.unfreeze({})).toBe(false);
    expect(store.freezeState("a")).toMatchObject({ scope: "agent" });
  });

  it("evaluatePolicy works against the real store (freeze end to end)", () => {
    const store = new SqlitePolicyStore(openDb(":memory:"));
    const run = () => evaluatePolicy(mandate(base), { tool: "create_refund", args: {} }, { now: NOW, facts: goodFacts("5.00"), store, amountBearing: true });
    expect(run().decision).toBe("allow");
    store.freeze({}, "kill");
    expect(run()).toMatchObject({ decision: "deny", reasons: [{ code: "frozen_global" }] });
  });

  it("SqliteReplayGuard accepts an id once", () => {
    const g = new SqliteReplayGuard(openDb(":memory:"));
    expect(g.consume("stp_1", 1)).toBe(true);
    expect(g.consume("stp_1", 1)).toBe(false);
    expect(g.consume("stp_2", 1)).toBe(true);
  });

  it("takes the database path from PAYLEASH_DB_PATH", async () => {
    const { resolveDbPath } = await import("../src/index.js");
    // OS-aware: on Windows `resolve` turns "/tmp/x/y.db" into "C:\\tmp\\x\\y.db", so compare resolved paths.
    expect(resolveDbPath({ PAYLEASH_DB_PATH: "/tmp/x/y.db" })).toBe(resolve("/tmp/x/y.db"));
    expect(resolveDbPath({})).toBe(resolve("payleash.db"));
  });
});
