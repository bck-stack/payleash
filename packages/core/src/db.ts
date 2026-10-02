import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Db = Database.Database;

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAYLEASH_DB_PATH ? resolve(env.PAYLEASH_DB_PATH) : resolve("payleash.db");
}

/** Each entry runs once, in order. Append only; never edit an applied migration. */
const MIGRATIONS: string[] = [
  // 1: policy state
  `
  CREATE TABLE spend_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id      TEXT    NOT NULL,
    tool          TEXT    NOT NULL,
    currency      TEXT    NOT NULL,
    amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
    status        TEXT    NOT NULL CHECK (status IN ('reserved','committed','released')),
    call_hash     TEXT    NOT NULL,
    result_id     TEXT,
    created_at_ms INTEGER NOT NULL
  );
  CREATE INDEX spend_ledger_window ON spend_ledger (agent_id, tool, currency, created_at_ms);

  CREATE TABLE freeze (
    scope        TEXT PRIMARY KEY,      -- 'global' or 'agent:<id>'
    reason       TEXT,
    frozen_at_ms INTEGER NOT NULL
  );

  CREATE TABLE stepup_used (
    id          TEXT PRIMARY KEY,
    used_at_ms  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  `,
  // 2: tamper-evident audit log (see audit/)
  `
  CREATE TABLE audit_log (
    seq              INTEGER PRIMARY KEY,
    ts               TEXT    NOT NULL,
    agent            TEXT    NOT NULL,
    tool             TEXT    NOT NULL,
    args             TEXT    NOT NULL,   -- canonical JSON
    decision         TEXT    NOT NULL,
    reasons          TEXT    NOT NULL,   -- canonical JSON
    mandate_id       TEXT,
    paypal_result_id TEXT,
    prev_hash        TEXT    NOT NULL,
    hash             TEXT    NOT NULL UNIQUE
  );
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
  // 3: the mandates the owner issued or the proxy has seen (metadata only, never the signed token)
  `
  CREATE TABLE mandates (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT    NOT NULL,
    claims_json   TEXT    NOT NULL,   -- canonical JSON of the verified Mandate
    not_before    INTEGER NOT NULL,   -- unix seconds
    expires_at    INTEGER NOT NULL,
    first_seen_ms INTEGER NOT NULL,
    source        TEXT    NOT NULL CHECK (source IN ('issued','seen'))
  );
  CREATE INDEX mandates_agent ON mandates (agent_id, not_before);
  `,
];

export function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Opens (and migrates) the SQLite database. Pass ":memory:" in tests. */
export function openDb(path: string = resolveDbPath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
