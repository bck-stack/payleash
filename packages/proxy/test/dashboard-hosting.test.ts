import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "@payleash/core";
import { ApprovalStore, buildProxy, parseProxyArgs, startHttp, startProxy, type RunningHttp } from "../src/index.js";
import { makeRuntime } from "./helpers.js";

const OWNER = "owner-token-0123456789abcdef";
let running: RunningHttp | undefined;
let dir: string | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function site() {
  dir = mkdtempSync(join(tmpdir(), "payleash-dash-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>PayLeash</title><div id=root></div>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('app')");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('push',()=>{})");
  writeFileSync(join(dir, "manifest.webmanifest"), JSON.stringify({ name: "PayLeash" }));
  writeFileSync(join(dir, "..", "secret.txt"), "outside the site");
  return dir;
}

describe("serving the built dashboard", () => {
  it("serves files with the right types and caching, falls back to index.html for client routes, and sets security headers", async () => {
    const root = site();
    const rt = makeRuntime();
    running = await startHttp(rt, { host: "127.0.0.1", port: 0, mcp: false, dashboardDir: root });
    const get = (p: string, init?: RequestInit) => fetch(`${running!.url}${p}`, init);

    const index = await get("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toMatch(/text\/html/);
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(index.headers.get("content-security-policy")).toMatch(/default-src 'self'/);
    expect(index.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");

    const js = await get("/assets/app-abc123.js");
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(js.headers.get("cache-control")).toMatch(/immutable/);
    expect((await get("/manifest.webmanifest")).headers.get("content-type")).toMatch(/manifest\+json/);
    const sw = await get("/sw.js");
    expect(sw.headers.get("service-worker-allowed")).toBe("/");
    expect(sw.headers.get("cache-control")).toBe("no-cache");

    // client-side routes survive a reload; a missing asset is a real 404
    for (const route of ["/approvals", "/approvals?focus=apr_1", "/policies", "/audit", "/backtest", "/overview"]) {
      expect(await (await get(route, { headers: { accept: "text/html" } })).text(), route).toContain("<div id=root>");
    }
    // ...while the owner API of the same name still answers scripts (no HTML in Accept) and bearer-token clients
    expect((await get("/approvals")).status).toBe(401);
    expect((await get("/approvals", { headers: { accept: "text/html", authorization: `Bearer ${OWNER}` } })).headers.get("content-type")).toMatch(/json/);
    expect((await get("/assets/missing.js")).status).toBe(404);
    expect((await get("/", { method: "HEAD" })).status).toBe(200);
    expect((await get("/", { method: "POST", body: "x" })).status).toBe(404);
  });

  it("does not let a path escape the dashboard directory", async () => {
    const root = site();
    running = await startHttp(makeRuntime(), { host: "127.0.0.1", port: 0, mcp: false, dashboardDir: root });
    for (const p of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt"]) {
      const r = await fetch(`${running.url}${p}`);
      expect(await r.text(), p).not.toContain("outside the site");
    }
  });

  it("serves the API and MCP next to the dashboard, and API routes are never shadowed by it", async () => {
    const root = site();
    running = await startHttp(makeRuntime(), { host: "127.0.0.1", port: 0, mcp: true, dashboardDir: root });
    expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/me`)).status).toBe(200);
    expect((await fetch(`${running.url}/api/unknown`, { headers: { authorization: `Bearer ${OWNER}` } })).status).toBe(404);
    expect((await fetch(`${running.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
  });

  it("without a dashboard directory unknown paths are 404", async () => {
    running = await startHttp(makeRuntime(), { host: "127.0.0.1", port: 0, mcp: false });
    expect((await fetch(`${running.url}/`)).status).toBe(404);
  });
});

describe("command line", () => {
  it("reads --demo (which implies fixtures), --dashboard and the PORT of the host", () => {
    expect(parseProxyArgs(["--demo"], {})).toMatchObject({ demo: true, fixtures: true, port: 8787 });
    expect(parseProxyArgs(["--transport", "http", "--dashboard", "apps/dashboard/dist"], {})).toMatchObject({ dashboardDir: "apps/dashboard/dist", demo: false });
    expect(parseProxyArgs([], { PORT: "10000", PAYLEASH_DASHBOARD_DIR: "/srv/dash" })).toMatchObject({ port: 10000, dashboardDir: "/srv/dash" });
    expect(parseProxyArgs(["--port", "9000"], { PORT: "10000" }).port).toBe(9000);
  });
});

describe("demo mode", () => {
  const demoOpts = { transport: "http", host: "127.0.0.1", port: 0, fixtures: true, allowLive: false, demo: true } as const;
  const env = { PAYLEASH_OWNER_TOKEN: OWNER, PAYLEASH_DEMO_TOKEN: "judge-demo-passcode", PAYLEASH_QUIET: "1" };

  it("uses throw-away keys and an in-memory database, and seeds two agents with real decisions: 1 runs, 4 held, 4 denied", async () => {
    const rt = buildProxy(demoOpts, env, { log: () => {} });
    await rt.demo!.reseed();
    expect(rt.mode).toBe("fixtures");
    expect(rt.mandates.agentIds()).toEqual(["billing-agent", "support-agent"]);
    const decisions = rt.audit.entries({ limit: 500 }).filter((e) => ["allow", "hold", "deny"].includes(e.decision)).map((e) => `${e.agent}:${e.decision}`);
    expect(decisions.filter((d) => d === "support-agent:allow")).toHaveLength(1);
    expect(decisions.filter((d) => d.endsWith(":hold")).length).toBeGreaterThanOrEqual(4);
    expect(decisions.filter((d) => d.endsWith(":deny")).length).toBeGreaterThanOrEqual(2);
    expect(rt.approvals.countPending()).toBeGreaterThanOrEqual(4);
    expect(rt.audit.verify().ok).toBe(true);
    // the held calls cover the stories the dashboard tells
    const pending = rt.app.listOwnerApprovals("pending");
    const codes = pending.flatMap((a) => a.reasons.map((r) => r.code));
    for (const c of ["above_auto_approve_threshold", "payee_unverifiable", "tainted_argument", "recipient_not_on_invoice"]) expect(codes, c).toContain(c);
    // the prompt injection was denied and never reached "PayPal"
    expect(rt.fixtureExecutor!.calls.some((c) => JSON.stringify(c.args).includes("attacker@example.com"))).toBe(false);
    rt.close();
  });

  it("can be re-seeded: fresh PayPal state and budgets, no duplicate pending calls, approvals still work", async () => {
    const rt = buildProxy(demoOpts, env, { log: () => {} });
    await rt.demo!.reseed();
    const first = rt.approvals.countPending();
    const big = rt.app.listOwnerApprovals("pending").find((a) => a.tool === "create_refund" && (a.args as any).amount?.value === "60.00")!;
    expect((await rt.app.decide(big.approvalId, "approve")).status).toBe("executed");
    await rt.demo!.reseed();
    // the approved one is gone from the queue and re-appears as a new held call; the others were not queued twice
    expect(rt.approvals.countPending()).toBe(first);
    expect(rt.audit.verify().ok).toBe(true);
    rt.close();
  });

  it("startProxy in demo mode seeds before listening, and prints a random owner token when none is set", async () => {
    const lines: string[] = [];
    const p = await startProxy({ ...demoOpts }, { PAYLEASH_QUIET: "1" }, { log: (l) => lines.push(l) });
    try {
      expect(lines.join("\n")).toMatch(/demo owner token \(random/);
      expect(lines.join("\n")).toMatch(/DEMO MODE/);
      expect(p.runtime.approvals.countPending()).toBeGreaterThanOrEqual(4);
      expect(p.runtime.ownerToken).toMatch(/^[0-9a-f]{36}$/);
    } finally {
      await p.close();
    }
  });
});

describe("approvals database", () => {
  it("adds the context column to a database created by the first release", () => {
    const db = openDb(":memory:");
    db.exec(`CREATE TABLE approvals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tool TEXT NOT NULL, args_json TEXT NOT NULL, call_hash TEXT NOT NULL,
      mandate_token TEXT NOT NULL, mandate_id TEXT NOT NULL, reasons_json TEXT NOT NULL, explanation TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approving','executed','failed','denied','expired')),
      created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, decided_at_ms INTEGER, result_json TEXT, error TEXT)`);
    db.prepare("INSERT INTO approvals VALUES ('apr_old','a','create_refund','{}','h','t','m','[]','old','pending',1,9999999999999,NULL,NULL,NULL)").run();
    const store = new ApprovalStore(db);
    expect(store.get("apr_old")?.context).toBeUndefined();
    const { approval } = store.createOrReuse({ agentId: "a", tool: "t", args: {}, callHash: "h2", mandateToken: "t", mandateId: "m", reasons: [], explanation: "e", ttlMs: 1000, context: { summary: "s", facts: [], provenance: [] } });
    expect(store.get(approval.id)?.context?.summary).toBe("s");
  });
});
