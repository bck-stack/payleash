import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTtl, runCli, type CliIo } from "../src/index.js";

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cliIo: CliIo = { out: (s) => out.push(s), err: (s) => err.push(s), env };
  return { out, err, cliIo };
}

describe("cli", () => {
  it("parses ttl", () => {
    expect(parseTtl("30d")).toBe(2592000);
    expect(parseTtl("90m")).toBe(5400);
    expect(() => parseTtl("soon")).toThrow();
  });

  it("keys init -> mandate issue -> mandate verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payleash-cli-"));
    try {
      const keyDir = join(dir, "keys");
      expect(await runCli(["keys", "init", "--dir", keyDir], io().cliIo)).toBe(0);
      const file = join(dir, "m.json");
      writeFileSync(file, JSON.stringify({ agentId: "a1", allowedTools: ["create_refund"], constraints: { create_refund: { currency: "USD", maxAmountPerOp: "10.00" } } }));
      const issue = io();
      expect(await runCli(["mandate", "issue", "--file", file, "--ttl", "1h", "--key-dir", keyDir], issue.cliIo)).toBe(0);
      const token = issue.out[0]!;
      const verify = io();
      expect(await runCli(["mandate", "verify", "--token", token, "--key-dir", keyDir], verify.cliIo)).toBe(0);
      expect(JSON.parse(verify.out.join("\n")).agentId).toBe("a1");
      // a second keys init must not silently overwrite
      const again = io();
      expect(await runCli(["keys", "init", "--dir", keyDir], again.cliIo)).toBe(1);
      expect(again.err.join()).toMatch(/already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("freeze / status / unfreeze drive the kill switch in the database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payleash-cli-"));
    try {
      const env = { PAYLEASH_DB_PATH: join(dir, "p.db") };
      const a = io(env);
      expect(await runCli(["freeze", "--reason", "drill"], a.cliIo)).toBe(0);
      expect(a.out.join()).toMatch(/GLOBAL FREEZE/);
      const s = io(env);
      await runCli(["status"], s.cliIo);
      expect(s.out.join()).toMatch(/frozen: global \(drill\)/);
      expect(await runCli(["unfreeze"], io(env).cliIo)).toBe(0);
      const s2 = io(env);
      await runCli(["status", "--agent", "a1"], s2.cliIo);
      expect(s2.out[0]).toBe("frozen: nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints usage for unknown commands", async () => {
    const r = io();
    expect(await runCli(["nope"], r.cliIo)).toBe(2);
  });
});
