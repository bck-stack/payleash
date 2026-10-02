import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startProxy, type RunningProxy } from "@payleash/proxy";
// @ts-expect-error plain ESM script without types
import { check } from "../check.mjs";

let p: RunningProxy | undefined;
let site: string | undefined;
afterEach(async () => {
  await p?.close();
  p = undefined;
  if (site) rmSync(site, { recursive: true, force: true });
  site = undefined;
});

const demo = async () => {
  site = mkdtempSync(join(tmpdir(), "payleash-uptime-"));
  writeFileSync(join(site, "index.html"), "<!doctype html><title>PayLeash</title><div id=root></div>");
  return startProxy({ transport: "http", host: "127.0.0.1", port: 0, fixtures: true, allowLive: false, demo: true, dashboardDir: site }, { PAYLEASH_OWNER_TOKEN: "owner-token-0123456789abcdef", PAYLEASH_DEMO_TOKEN: "judge-demo-2026", PAYLEASH_DEMO_SHOW: "1", PAYLEASH_QUIET: "1" }, { log: () => {} });
};

describe("uptime self-check", () => {
  it("passes against a running demo and reports each step", async () => {
    p = await demo();
    const lines: string[] = [];
    const r = await check(p.http!.url, { attempts: 1, log: (l: string) => lines.push(l) });
    expect(r.ok, lines.join("\n")).toBe(true);
    expect(lines.filter((l) => l.startsWith("ok")).length).toBeGreaterThanOrEqual(4);
  });

  it("retries while a sleeping service wakes up, then passes", async () => {
    p = await demo();
    let calls = 0;
    const flaky = (url: string, init?: RequestInit) => (++calls <= 2 ? Promise.reject(new Error("connect ETIMEDOUT")) : fetch(url, init));
    const r = await check(p.http!.url, { attempts: 3, waitMs: 10, fetchImpl: flaky });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it("fails when the server is down or is not a demo", async () => {
    const down = await check("http://127.0.0.1:9", { attempts: 2, waitMs: 5, timeoutMs: 500 });
    expect(down.ok).toBe(false);
    const notDemo = async () => new Response(JSON.stringify({ ok: true, mode: "sandbox", demo: false }), { status: 200 });
    const r = await check("http://x.invalid", { attempts: 1, fetchImpl: notDemo as unknown as typeof fetch });
    expect(r.ok).toBe(false);
  });
});
