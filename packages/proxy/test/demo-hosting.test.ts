import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { issueMandate } from "@payleash/core";
import { blockPayPalEgress, msUntilNextHourUtc, resetDemo, scheduleNightlyReset, startProxy, type RunningProxy } from "../src/index.js";

const OWNER = "owner-token-0123456789abcdef";
const DEMO = "judge-demo-2026";
const env = { PAYLEASH_OWNER_TOKEN: OWNER, PAYLEASH_DEMO_TOKEN: DEMO, PAYLEASH_DEMO_SHOW: "1", PAYLEASH_QUIET: "1", PAYLEASH_DEMO_NIGHTLY_RESET: "1" };
let running: RunningProxy | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await running?.close();
  running = undefined;
});
const start = async (extra: NodeJS.ProcessEnv = {}) => {
  running = await startProxy({ transport: "http", host: "127.0.0.1", port: 0, fixtures: true, allowLive: false, demo: true }, { ...env, ...extra }, { log: () => {} });
  return running;
};

describe("hosted demo: health", () => {
  it("answers /healthz and /api/health with a cheap, public, secret-free status", async () => {
    const p = await start();
    for (const path of ["/healthz", "/api/health"]) {
      const res = await fetch(`${p.http!.url}${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({ ok: true, mode: "fixtures", demo: true, audit: { entries: expect.any(Number) }, pending: 5, reset: { count: 0 } });
      expect(body.reset.next).toMatch(/T03:00:00\.000Z$/);
      expect(JSON.stringify(body)).not.toMatch(new RegExp(`${OWNER}|${DEMO}`));
    }
  });
  it("reports 503 when the database is gone", async () => {
    const p = await start();
    p.runtime.db.close();
    const res = await fetch(`${p.http!.url}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});

describe("hosted demo: nightly reset", () => {
  it("computes the next 03:00 UTC", () => {
    expect(msUntilNextHourUtc(new Date("2026-10-02T01:00:00Z"), 3)).toBe(2 * 3600_000);
    expect(msUntilNextHourUtc(new Date("2026-10-02T03:00:00Z"), 3)).toBe(24 * 3600_000);
    expect(msUntilNextHourUtc(new Date("2026-10-02T23:30:00Z"), 3)).toBe(3.5 * 3600_000);
  });

  it("wipes what visitors did and puts the seeded demo back, with a chain that still verifies", async () => {
    const p = await start();
    const rt = p.runtime;
    const fresh = { entries: rt.audit.head().seq, pending: rt.approvals.countPending() };
    // A judge approves a held call and a visitor's agent leaves a trace.
    const first = rt.approvals.list("pending")[0]!;
    await rt.app.decide(first.id, "approve");
    rt.app.freeze(undefined, "visitor");
    expect(rt.audit.head().seq).toBeGreaterThan(fresh.entries);
    expect(rt.approvals.countPending()).toBe(fresh.pending - 1);

    await resetDemo(rt);
    expect(rt.audit.head().seq).toBe(fresh.entries);
    expect(rt.approvals.countPending()).toBe(fresh.pending);
    expect(rt.policy.freezeState("support-agent").frozen).toBe(false);
    expect(rt.audit.verify().ok).toBe(true);
    // ...and the audit log is append-only again afterwards
    expect(() => rt.db.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
    expect(() => rt.db.prepare("UPDATE audit_log SET agent = 'x'").run()).toThrow(/append-only/);
  });

  it("is scheduled by PAYLEASH_DEMO_NIGHTLY_RESET and runs on the clock", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-02T02:00:00Z"), toFake: ["setTimeout", "Date"] });
    const p = await start();
    const rt = p.runtime;
    expect(rt.demoStatus!.nextResetAt).toBe("2026-10-02T03:00:00.000Z");
    await rt.app.decide(rt.approvals.list("pending")[0]!.id, "approve");
    await vi.advanceTimersByTimeAsync(3600_000 + 10);
    await vi.waitFor(() => expect(rt.demoStatus!.resets).toBe(1));
    expect(rt.demoStatus!.nextResetAt).toBe("2026-10-03T03:00:00.000Z");
    expect(rt.approvals.countPending()).toBe(5);
  });

  it("can be cancelled, and a failing reset does not kill the schedule", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-02T02:00:00Z"), toFake: ["setTimeout", "Date"] });
    const p = await start({ PAYLEASH_DEMO_NIGHTLY_RESET: "0" });
    const rt = p.runtime;
    const logs: string[] = [];
    const cancel = scheduleNightlyReset(rt, { log: (l) => logs.push(l) });
    rt.db.exec("ALTER TABLE approvals RENAME TO approvals_gone");
    await vi.advanceTimersByTimeAsync(3600_000 + 10);
    await vi.waitFor(() => expect(logs.join("\n")).toMatch(/FAILED/));
    rt.db.exec("ALTER TABLE approvals_gone RENAME TO approvals");
    cancel();
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(logs.filter((l) => /FAILED|done/.test(l))).toHaveLength(1);
  });
});

describe("hosted demo: nothing can reach PayPal", () => {
  it("throws for any PayPal host, whatever the environment holds, and the whole demo flow makes no PayPal request", async () => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
      return real(input, init);
    }) as typeof fetch;
    try {
      // A live PayPal URL stops the server from starting at all; sandbox-looking credentials are simply ignored by --demo.
      await expect(start({ PAYPAL_BASE_URL: "https://api-m.paypal.com" })).rejects.toThrow(/not the PayPal sandbox/);
      const p = await start({ PAYPAL_CLIENT_ID: "sandbox-id", PAYPAL_CLIENT_SECRET: "sandbox-secret" });
      expect(p.runtime.mode).toBe("fixtures");
      expect(p.runtime.paypalHttp).toBeUndefined();
      blockPayPalEgress();
      await expect(fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token")).rejects.toThrow(/blocked/);
      await expect(fetch("https://api-m.paypal.com/v2/payments/captures/x")).rejects.toThrow(/blocked/);
      await expect(fetch("https://www.paypalobjects.com/x")).rejects.toThrow(/blocked/);

      // An agent works through MCP and the owner decides; nothing leaves for PayPal.
      const rt = p.runtime;
      const { token } = await issueMandate(rt.ownerPrivateKey!, { agentId: "visitor-agent", allowedTools: ["create_refund", "get_order"], constraints: { create_refund: { currency: "USD", maxAmountPerOp: "100.00", autoApproveThreshold: "25.00" } } }, { issuer: "t", ttlSeconds: 600 });
      const client = new Client({ name: "t", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${p.http!.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      await client.callTool({ name: "create_refund", arguments: { capture_id: "3C679366HH908993F", amount: { currency_code: "USD", value: "10.00" } } });
      await client.callTool({ name: "get_order", arguments: { id: "7GH23478AB129876K" } });
      await client.close();
      const login = await fetch(`${p.http!.url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: DEMO }) });
      expect(login.status).toBe(200);
      expect(seen.filter((u) => /paypal/i.test(new URL(u).hostname))).toEqual([]); // the guard sits in front of every other fetch
    } finally {
      globalThis.fetch = real;
    }
  });
});
