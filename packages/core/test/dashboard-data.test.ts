import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AuditLog,
  DEMO_IDS,
  FixturePayPalReader,
  Guard,
  MandateRegistry,
  RegistryBook,
  SqlitePolicyStore,
  SqliteReplayGuard,
  buildCallContext,
  buildDemoFixtures,
  initVapid,
  issueMandate,
  loadVapid,
  moneyText,
  openDb,
  originOf,
  runCli,
  type CliIo,
  type MandateInput,
} from "../src/index.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const I = DEMO_IDS;
const owner = generateKeyPairSync("ed25519");
const MANDATE: MandateInput = {
  agentId: "support-agent",
  allowedTools: ["create_refund", "send_invoice", "accept_dispute_claim", "cancel_subscription"],
  constraints: { create_refund: { currency: "USD", maxAmountPerOp: "100.00", dailyTotal: "300.00", autoApproveThreshold: "25.00", payeeMustBeOriginalBuyer: true, orderAgeDays: 60 } },
};

async function setup() {
  const db = openDb(":memory:");
  const registries = new RegistryBook();
  const mandates = new MandateRegistry(db);
  const audit = new AuditLog(db);
  const guard = new Guard({
    policy: new SqlitePolicyStore(db),
    audit,
    replay: new SqliteReplayGuard(db),
    reader: new FixturePayPalReader(buildDemoFixtures(NOW)),
    registries,
    ownerPublicKey: owner.publicKey,
    stepUpPublicKey: owner.publicKey,
    mandates,
    now: () => NOW,
  });
  const { token, mandate } = await issueMandate(owner.privateKey, MANDATE, { issuer: "owner", ttlSeconds: 86400, now: NOW });
  return { db, registries, mandates, audit, guard, token, mandate };
}
const refund = (capture_id: string, value?: string, extra: Record<string, unknown> = {}) => ({ capture_id, ...(value ? { amount: { currency_code: "USD", value } } : {}), ...extra });

describe("call description", () => {
  it("describes a held refund in plain language from PayPal's records, with the provenance of each argument", async () => {
    const s = await setup();
    s.registries.forAgent("support-agent").register("gmail:msg-1", "Please refund me $60.00", NOW);
    const args = refund(I.capture100, "60.00", { payee_email: "bob@example.com" });
    const a = await s.guard.authorize({ mandateToken: s.token, tool: "create_refund", args });
    expect(a.decision).toBe("hold");
    const ctx = buildCallContext({ tool: "create_refund", args, assessments: a.args, facts: a.facts, truth: a.truth, now: NOW });
    expect(ctx.summary).toBe("Refund $60.00 on order 7GH23478AB129876K, captured $100.00, $30.00 already refunded, buyer bob@example.com");
    expect(ctx.facts.find((f) => f.label === "Buyer")?.value).toBe("bob@example.com");
    expect(ctx.facts.find((f) => f.label === "Still refundable")?.value).toBe("$70.00");
    const byPath = Object.fromEntries(ctx.provenance.map((p) => [p.path, p]));
    expect(byPath["capture_id"]).toMatchObject({ status: "verified", origin: "paypal", label: "PayPal-verified", roleLabel: "Payment (capture)" });
    expect(byPath["amount.value"]).toMatchObject({ status: "tainted", origin: "customer_email" });
    expect(byPath["amount.value"]!.label).toMatch(/Customer email \(gmail:msg-1\)/);
    expect(byPath["payee_email"]!.origin).toBe("paypal");
  });

  it("says plainly when PayPal shows no buyer (card payment), and describes a full refund", async () => {
    const s = await setup();
    const args = refund(I.captureCard);
    const a = await s.guard.authorize({ mandateToken: s.token, tool: "create_refund", args });
    const ctx = buildCallContext({ tool: "create_refund", args, assessments: a.args, facts: a.facts, truth: a.truth, now: NOW });
    expect(ctx.summary).toMatch(/^Refund everything that is left on order 3CD45678EF901234G, captured \$64\.00, buyer not shown by PayPal \(card payment\)$/);
    expect(ctx.amount?.text).toBe("$64.00");
  });

  it("describes invoices, disputes and subscriptions, and falls back for tools it does not model", async () => {
    const s = await setup();
    const inv = await s.guard.authorize({ mandateToken: s.token, tool: "send_invoice", args: { invoice_id: I.invoiceLarge } });
    expect(buildCallContext({ tool: "send_invoice", args: { invoice_id: I.invoiceLarge }, assessments: inv.args, facts: inv.facts, truth: inv.truth, now: NOW }).summary).toBe(`Send invoice ${I.invoiceLarge} (total $450.00) to bob@example.com`);
    const dsp = await s.guard.authorize({ mandateToken: s.token, tool: "accept_dispute_claim", args: { dispute_id: I.dispute } });
    expect(buildCallContext({ tool: "accept_dispute_claim", args: { dispute_id: I.dispute }, assessments: dsp.args, facts: dsp.facts, truth: dsp.truth, now: NOW }).summary).toMatch(/^Accept dispute PP-D-27803 and give up \$42\.00, buyer alice@example\.com$/);
    const sub = await s.guard.authorize({ mandateToken: s.token, tool: "cancel_subscription", args: { subscription_id: I.subscription } });
    expect(buildCallContext({ tool: "cancel_subscription", args: { subscription_id: I.subscription }, assessments: sub.args, facts: sub.facts, truth: sub.truth, now: NOW }).summary).toBe(`Cancel subscription ${I.subscription} of dave@example.com`);
    expect(buildCallContext({ tool: "update_plan", args: { plan_id: "P-1" }, assessments: [], facts: {}, now: NOW }).summary).toBe("Update plan");
  });

  it("labels where an untrusted value came from", () => {
    expect(originOf({ status: "tainted", sources: ["paypal:dispute:PP-D-1:message:0"] }).origin).toBe("dispute_message");
    expect(originOf({ status: "tainted", sources: ["gmail:abc"] }).origin).toBe("customer_email");
    expect(originOf({ status: "tainted", sources: ["ticket:7"] }).origin).toBe("support_ticket");
    expect(originOf({ status: "tainted", sources: ["something"] }).origin).toBe("untrusted_text");
    expect(originOf({ status: "unknown", sources: [] }).label).toMatch(/^Unknown/);
    expect(moneyText(6000, "USD")).toBe("$60.00");
    expect(moneyText(6000, "CHF")).toBe("60.00 CHF");
  });
});

describe("mandate registry", () => {
  it("remembers every mandate the guard verifies and reports the one in force", async () => {
    const s = await setup();
    await s.guard.authorize({ mandateToken: s.token, tool: "create_refund", args: refund(I.capture42, "5.00") });
    expect(s.mandates.agentIds()).toEqual(["support-agent"]);
    const cur = s.mandates.current("support-agent", Math.floor(NOW.getTime() / 1000))!;
    expect(cur.mandate.id).toBe(s.mandate.id);
    expect(cur.source).toBe("seen");
    expect(JSON.stringify(cur)).not.toContain(s.token);
    // issued wins over seen, and a newer valid mandate replaces it as the current one
    s.mandates.record(s.mandate, "issued");
    expect(s.mandates.current("support-agent", Math.floor(NOW.getTime() / 1000))!.source).toBe("issued");
    const newer = (await issueMandate(owner.privateKey, { ...MANDATE, constraints: { create_refund: { currency: "USD", maxAmountPerOp: "50.00" } } }, { issuer: "owner", ttlSeconds: 86400, now: new Date(NOW.getTime() + 3600_000) })).mandate;
    s.mandates.record(newer, "issued");
    expect(s.mandates.current("support-agent", Math.floor(NOW.getTime() / 1000) + 7200)!.mandate.id).toBe(newer.id);
    // after everything expired, the newest is still reported (so the dashboard can say "expired")
    expect(s.mandates.current("support-agent", Math.floor(NOW.getTime() / 1000) + 10 * 86400)!.mandate.id).toBe(newer.id);
    expect(s.mandates.current("nobody")).toBeUndefined();
  });

  it("`mandate issue --record` saves claims, and nothing is written without it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payleash-reg-"));
    try {
      const keyDir = join(dir, "k");
      const out: string[] = [];
      const io = (env: NodeJS.ProcessEnv = {}): CliIo => ({ out: (x) => out.push(x), err: () => {}, env });
      await runCli(["keys", "init", "--dir", keyDir], io());
      const file = join(dir, "m.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, JSON.stringify(MANDATE));
      const db = join(dir, "x.db");
      expect(await runCli(["mandate", "issue", "--file", file, "--key-dir", keyDir, "--record"], io({ PAYLEASH_DB_PATH: db }))).toBe(0);
      const d = openDb(db);
      expect(new MandateRegistry(d).agentIds()).toEqual(["support-agent"]);
      d.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("audit paging and counts", () => {
  it("pages forward from a cursor and returns the latest entries when there is none; counts decisions per agent", async () => {
    const s = await setup();
    for (const v of ["1.00", "2.00", "3.00"]) await s.guard.authorize({ mandateToken: s.token, tool: "create_refund", args: refund(I.capture42, v) });
    await s.guard.authorize({ mandateToken: s.token, tool: "create_refund", args: refund(I.capture42, "999.00") });
    expect(s.audit.page({ limit: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(s.audit.page({ afterSeq: 1, limit: 2 }).map((e) => e.seq)).toEqual([2, 3]);
    expect(s.audit.page({ afterSeq: 4 })).toEqual([]);
    expect(s.audit.page({ agent: "nobody" })).toEqual([]);
    const counts = s.audit.decisionCountsSince("2026-10-01T00:00:00.000Z");
    expect(counts).toEqual(expect.arrayContaining([{ agent: "support-agent", decision: "allow", n: 3 }, { agent: "support-agent", decision: "deny", n: 1 }]));
    expect(s.audit.decisionCountsSince("2026-10-02T00:00:00.000Z")).toEqual([]);
  });
});

describe("VAPID keys", () => {
  it("generates a P-256 pair in web-push format, stores it outside the repo with private permissions, and loads it", () => {
    const dir = mkdtempSync(join(tmpdir(), "payleash-vapid-"));
    try {
      const r = initVapid({ dir: join(dir, "k"), subject: "mailto:me@example.com" });
      expect(Buffer.from(r.keys.publicKey, "base64url")).toHaveLength(65);
      expect(Buffer.from(r.keys.publicKey, "base64url")[0]).toBe(4);
      expect(Buffer.from(r.keys.privateKey, "base64url")).toHaveLength(32);
      if (process.platform !== "win32") expect(statSync(r.file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(r.file, "utf8")).subject).toBe("mailto:me@example.com");
      expect(loadVapid({ PAYLEASH_KEY_DIR: join(dir, "k") })?.publicKey).toBe(r.keys.publicKey);
      expect(() => initVapid({ dir: join(dir, "k"), subject: "mailto:me@example.com" })).toThrow(/already exists/);
      expect(() => initVapid({ dir: join(dir, "k2"), subject: "not a contact" })).toThrow(/--subject/);
      expect(() => initVapid({ dir: process.cwd(), subject: "mailto:me@example.com" })).toThrow(/git repository/);
      expect(loadVapid({ PAYLEASH_KEY_DIR: join(dir, "nothing") })).toBeNull();
      expect(loadVapid({ PAYLEASH_VAPID_PUBLIC: "a", PAYLEASH_VAPID_PRIVATE: "b" })).toMatchObject({ publicKey: "a", privateKey: "b" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
