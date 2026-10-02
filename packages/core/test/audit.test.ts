import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, GENESIS_HASH, openDb, runCli, type CliIo, type Db } from "../src/index.js";

function seeded(): { db: Db; log: AuditLog } {
  const db = openDb(":memory:");
  const log = new AuditLog(db);
  log.append({ agent: "a1", tool: "create_refund", args: { capture_id: "C1", amount: { value: "10.00", currency_code: "USD" } }, decision: "allow", mandateId: "mnd_1" });
  log.append({ agent: "a1", tool: "create_refund", args: { capture_id: "C1" }, decision: "executed", mandateId: "mnd_1", paypalResultId: "REFUND123" });
  log.append({ agent: "a1", tool: "create_refund", args: { capture_id: "C2", amount: { value: "999.00", currency_code: "USD" } }, decision: "deny", reasons: [{ code: "payee_not_original_buyer", message: "no" }] });
  log.append({ agent: "a2", tool: "cancel_subscription", args: { subscription_id: "I-1" }, decision: "hold" });
  return { db, log };
}

/** What an attacker with write access to the file would do: drop the append-only triggers first. */
const dropTriggers = (db: Db) => db.exec("DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;");

describe("audit log", () => {
  it("chains entries: genesis -> prev/hash linkage, canonical args, all fields recorded", () => {
    const { log } = seeded();
    const [e1, e2, e3] = log.entries();
    expect(e1!.prevHash).toBe(GENESIS_HASH);
    expect(e2!.prevHash).toBe(e1!.hash);
    expect(e3!.prevHash).toBe(e2!.hash);
    expect(e1!.args).toBe('{"amount":{"currency_code":"USD","value":"10.00"},"capture_id":"C1"}');
    expect(e2).toMatchObject({ agent: "a1", tool: "create_refund", decision: "executed", mandateId: "mnd_1", paypalResultId: "REFUND123" });
    expect(JSON.parse(e3!.reasons)).toEqual([{ code: "payee_not_original_buyer", message: "no" }]);
    expect(new Date(e1!.ts).toString()).not.toBe("Invalid Date");
    expect(log.head()).toEqual({ seq: 4, hash: log.entries().at(-1)!.hash });
  });

  it("verifies an untouched log", () => {
    const { log } = seeded();
    expect(log.verify()).toMatchObject({ ok: true, entries: 4, headSeq: 4, problems: [] });
    expect(new AuditLog(openDb(":memory:")).verify()).toMatchObject({ ok: true, entries: 0 });
  });

  it("TAMPER: editing a row makes verify fail (triggers dropped by the attacker)", () => {
    const { db, log } = seeded();
    dropTriggers(db);
    db.prepare("UPDATE audit_log SET decision = 'allow', reasons = '[]' WHERE seq = 3").run(); // hide the denied $999 refund
    const r = log.verify();
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ seq: 3, problem: "bad_hash" }));
  });

  it("TAMPER: editing a row and recomputing only its own hash still breaks the chain", () => {
    const { db, log } = seeded();
    dropTriggers(db);
    db.prepare("UPDATE audit_log SET paypal_result_id = 'FORGED', hash = ? WHERE seq = 2").run("f".repeat(64));
    const r = log.verify();
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.problem)).toEqual(expect.arrayContaining(["bad_hash", "bad_prev_hash"]));
  });

  it("TAMPER: deleting or inserting rows is detected", () => {
    const { db, log } = seeded();
    dropTriggers(db);
    db.prepare("DELETE FROM audit_log WHERE seq = 2").run();
    expect(log.verify().problems.map((p) => p.problem)).toEqual(expect.arrayContaining(["bad_sequence", "bad_prev_hash"]));
  });

  it("TAMPER: truncating the tail is detected against a recorded head hash", () => {
    const { db, log } = seeded();
    const anchor = log.head().hash;
    dropTriggers(db);
    db.prepare("DELETE FROM audit_log WHERE seq = 4").run();
    expect(log.verify().ok).toBe(true); // a chain alone cannot see this...
    expect(log.verify({ expectedHead: anchor }).ok).toBe(false); // ...an externally recorded head can
  });

  it("the triggers refuse UPDATE and DELETE outright", () => {
    const { db } = seeded();
    expect(() => db.prepare("UPDATE audit_log SET agent = 'x' WHERE seq = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_log WHERE seq = 1").run()).toThrow(/append-only/);
  });

  it("filters entries by agent", () => {
    const { log } = seeded();
    expect(log.entries({ agent: "a2" }).map((e) => e.tool)).toEqual(["cancel_subscription"]);
  });
});

describe("payleash audit verify (CLI)", () => {
  function cli(env: NodeJS.ProcessEnv) {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (s) => out.push(s), err: (s) => err.push(s), env };
    return { out, err, io };
  }

  it("exits 0 on a clean log and 1 after the database file is edited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payleash-audit-"));
    try {
      const path = join(dir, "p.db");
      const db = openDb(path);
      const log = new AuditLog(db);
      log.append({ agent: "a", tool: "create_refund", args: { x: 1 }, decision: "allow" });
      log.append({ agent: "a", tool: "create_refund", args: { x: 1 }, decision: "executed", paypalResultId: "R1" });
      db.close();

      const ok = cli({ PAYLEASH_DB_PATH: path });
      expect(await runCli(["audit", "verify"], ok.io)).toBe(0);
      expect(ok.out[0]).toMatch(/audit log OK: 2 entries/);

      const raw = openDb(path);
      dropTriggers(raw);
      raw.prepare("UPDATE audit_log SET args = '{\"x\":999}' WHERE seq = 1").run();
      raw.close();

      const bad = cli({ PAYLEASH_DB_PATH: path });
      expect(await runCli(["audit", "verify"], bad.io)).toBe(1);
      expect(bad.err.join("\n")).toMatch(/TAMPERING DETECTED[\s\S]*#1 bad_hash/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
