import type { Db } from "../db.js";
import type { ReplayGuard } from "../mandate/sign.js";
import type { Money } from "../money.js";
import { DAY_MS } from "./evaluate.js";
import type { FreezeState, PolicyStore } from "./types.js";

export interface Reservation {
  id: number;
}

export interface SpendSummaryRow {
  tool: string;
  currency: string;
  operations: number;
  totalMinor: number;
}

/** SQLite-backed budgets, counters and kill switch. */
export class SqlitePolicyStore implements PolicyStore {
  constructor(private readonly db: Db) {}

  // ---- kill switch -------------------------------------------------------

  freeze(scope: { agentId?: string } = {}, reason?: string, now = new Date()): void {
    this.db
      .prepare("INSERT INTO freeze (scope, reason, frozen_at_ms) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET reason = excluded.reason, frozen_at_ms = excluded.frozen_at_ms")
      .run(scopeKey(scope.agentId), reason ?? null, now.getTime());
  }

  unfreeze(scope: { agentId?: string } = {}): boolean {
    return this.db.prepare("DELETE FROM freeze WHERE scope = ?").run(scopeKey(scope.agentId)).changes > 0;
  }

  freezeState(agentId: string): FreezeState {
    const rows = this.db.prepare("SELECT scope, reason FROM freeze WHERE scope IN ('global', ?)").all(`agent:${agentId}`) as { scope: string; reason: string | null }[];
    const global = rows.find((r) => r.scope === "global");
    if (global) return { frozen: true, scope: "global", reason: global.reason ?? undefined };
    const agent = rows[0];
    return agent ? { frozen: true, scope: "agent", reason: agent.reason ?? undefined } : { frozen: false };
  }

  frozenScopes(): { scope: string; reason: string | null; frozenAtMs: number }[] {
    return (this.db.prepare("SELECT scope, reason, frozen_at_ms AS frozenAtMs FROM freeze ORDER BY scope").all() as any[]);
  }

  // ---- budgets -----------------------------------------------------------

  spentSince(agentId: string, tool: string, currency: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount_minor), 0) AS total FROM spend_ledger WHERE agent_id = ? AND tool = ? AND currency = ? AND status IN ('reserved','committed') AND created_at_ms > ?",
      )
      .get(agentId, tool, currency, sinceMs) as { total: number };
    return row.total;
  }

  /**
   * Atomically reserves `amount` against `dailyLimitMinor` (rolling 24h). Returns null if it would not fit.
   * Reserve right after `evaluatePolicy` with no `await` in between, then `commit` or `release` after executing.
   */
  reserve(args: { agentId: string; tool: string; amount: Money; callHash: string; dailyLimitMinor?: number; now?: Date }): Reservation | null {
    const now = (args.now ?? new Date()).getTime();
    const tx = this.db.transaction((): Reservation | null => {
      if (args.dailyLimitMinor !== undefined) {
        const spent = this.spentSince(args.agentId, args.tool, args.amount.currency, now - DAY_MS);
        if (spent + args.amount.minor > args.dailyLimitMinor) return null;
      }
      const info = this.db
        .prepare("INSERT INTO spend_ledger (agent_id, tool, currency, amount_minor, status, call_hash, created_at_ms) VALUES (?, ?, ?, ?, 'reserved', ?, ?)")
        .run(args.agentId, args.tool, args.amount.currency, args.amount.minor, args.callHash, now);
      return { id: Number(info.lastInsertRowid) };
    });
    return tx.immediate();
  }

  commit(r: Reservation, resultId?: string): void {
    this.db.prepare("UPDATE spend_ledger SET status = 'committed', result_id = ? WHERE id = ? AND status = 'reserved'").run(resultId ?? null, r.id);
  }

  release(r: Reservation): void {
    this.db.prepare("UPDATE spend_ledger SET status = 'released' WHERE id = ? AND status = 'reserved'").run(r.id);
  }

  /** Per-tool operation counts and totals for the last 24h. */
  summary(agentId: string, now = new Date()): SpendSummaryRow[] {
    return this.db
      .prepare(
        `SELECT tool, currency, COUNT(*) AS operations, COALESCE(SUM(amount_minor),0) AS totalMinor
         FROM spend_ledger WHERE agent_id = ? AND status IN ('reserved','committed') AND created_at_ms > ?
         GROUP BY tool, currency ORDER BY tool, currency`,
      )
      .all(agentId, now.getTime() - DAY_MS) as SpendSummaryRow[];
  }
}

const scopeKey = (agentId?: string) => (agentId ? `agent:${agentId}` : "global");

/** Single-use ledger for step-up mandates. */
export class SqliteReplayGuard implements ReplayGuard {
  constructor(private readonly db: Db) {}
  consume(id: string, expiresAt: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO stepup_used (id, used_at_ms, expires_at) VALUES (?, ?, ?)").run(id, Date.now(), expiresAt).changes === 1;
  }
}
