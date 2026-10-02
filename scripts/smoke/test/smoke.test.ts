import { generateKeyPairSync } from "node:crypto";
import { DEMO_IDS, issueMandate, openDb } from "@payleash/core";
import { buildProxy, startHttp, type RunningHttp } from "@payleash/proxy";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/index.js";
import { runSmoke } from "../src/smoke.js";

const owner = generateKeyPairSync("ed25519");
const stepup = generateKeyPairSync("ed25519");
const OWNER_TOKEN = "owner-token-0123456789abcdef";
let http: RunningHttp | undefined;
afterEach(async () => {
  await http?.close();
  http = undefined;
});

async function boot(thresholds = { autoApproveThreshold: "25.00" }) {
  const rt = buildProxy(
    { transport: "http", host: "127.0.0.1", port: 0, fixtures: true, allowLive: false },
    { PAYLEASH_OWNER_TOKEN: OWNER_TOKEN },
    { db: openDb(":memory:"), keys: { ownerPublic: owner.publicKey, stepUpPrivate: stepup.privateKey, stepUpPublic: stepup.publicKey }, log: () => {} },
  );
  http = await startHttp(rt, { host: "127.0.0.1", port: 0, mcp: true });
  const { token } = await issueMandate(
    owner.privateKey,
    { agentId: "smoke-agent", allowedTools: ["create_refund"], constraints: { create_refund: { currency: "USD", maxAmountPerOp: "100.00", dailyTotal: "300.00", payeeMustBeOriginalBuyer: true, ...thresholds } } },
    { issuer: "owner", ttlSeconds: 3600 },
  );
  return { url: http.url, token, rt };
}

describe("smoke client against a fixture-mode proxy", () => {
  it("passes all checks: small refund runs, large held then approved, injection denied, kill switch, audit verifies", async () => {
    const { url, token, rt } = await boot();
    const lines: string[] = [];
    const r = await runSmoke({ url, mandate: token, ownerToken: OWNER_TOKEN, captureSmall: DEMO_IDS.capture42, captureLarge: DEMO_IDS.capture100, log: (l) => lines.push(l) });
    expect(r.steps.map((s) => [s.name, s.pass])).toEqual([
      ["small refund runs", true],
      ["large refund is held", true],
      ["owner approval executes the held refund", true],
      ["prompt-injection refund is denied", true],
      ["kill switch denies writes", true],
      ["audit chain verifies", true],
    ]);
    expect(r.ok).toBe(true);
    expect(rt.fixtureExecutor!.calls.filter((c) => c.method === "create_refund")).toHaveLength(2); // the small one and the approved large one; never the $999
  });

  it("--no-approve stops at pending_approval", async () => {
    const { url, token } = await boot();
    const r = await runSmoke({ url, mandate: token, ownerToken: OWNER_TOKEN, captureSmall: DEMO_IDS.capture42, captureLarge: DEMO_IDS.capture100, approve: false });
    expect(r.steps.map((s) => s.name)).not.toContain("owner approval executes the held refund");
    expect(r.ok).toBe(true);
  });

  it("FAILS (not silently passes) when the mandate has no threshold: the 'small' refund is held instead of run", async () => {
    const { url, token } = await boot({} as never);
    const r = await runSmoke({ url, mandate: token, ownerToken: OWNER_TOKEN, captureSmall: DEMO_IDS.capture42, captureLarge: DEMO_IDS.capture100 });
    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ name: "small refund runs", pass: false });
  });

  it("CLI: explains what is missing and exits 2; runs end to end with everything set", async () => {
    const out: string[] = [];
    expect(await main([], {}, (s) => out.push(s))).toBe(2);
    expect(out.join("\n")).toMatch(/Missing: .*--capture-small.*PAYLEASH_MANDATE/);

    const { url, token } = await boot();
    const run: string[] = [];
    const code = await main(["--", "--capture-small", DEMO_IDS.capture42, "--capture-large", DEMO_IDS.capture100, "--url", url], { PAYLEASH_MANDATE: token, PAYLEASH_OWNER_TOKEN: OWNER_TOKEN }, (s) => run.push(s));
    expect(code).toBe(0);
    expect(run.join("\n")).toMatch(/ALL CHECKS PASSED/);
  });
});
