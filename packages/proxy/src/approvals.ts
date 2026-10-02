import { randomUUID } from "node:crypto";
import { canonicalize, type Db, type Reason } from "@payleash/core";

export type ApprovalStatus = "pending" | "approving" | "executed" | "failed" | "denied" | "expired";

export interface Approval {
  id: string;
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  callHash: string;
  mandateId: string;
  reasons: Reason[];
  explanation: string;
  status: ApprovalStatus;
  createdAtMs: number;
  expiresAtMs: number;
  decidedAtMs?: number;
  result?: unknown;
  error?: string;
}

type Row = {
  id: string;
  agent_id: string;
  tool: string;
  args_json: string;
  call_hash: string;
  mandate_token: string;
  mandate_id: string;
  reasons_json: string;
  explanation: string;
  status: ApprovalStatus;
  created_at_ms: number;
  expires_at_ms: number;
  decided_at_ms: number | null;
  result_json: string | null;
  error: string | null;
};

export function ensureApprovalSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      tool          TEXT NOT NULL,
      args_json     TEXT NOT NULL,
      call_hash     TEXT NOT NULL,
      mandate_token TEXT NOT NULL,
      mandate_id    TEXT NOT NULL,
      reasons_json  TEXT NOT NULL,
      explanation   TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('pending','approving','executed','failed','denied','expired')),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      decided_at_ms INTEGER,
      result_json   TEXT,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, created_at_ms);
  `);
}

const toApproval = (r: Row): Approval => ({
  id: r.id,
  agentId: r.agent_id,
  tool: r.tool,
  args: JSON.parse(r.args_json),
  callHash: r.call_hash,
  mandateId: r.mandate_id,
  reasons: JSON.parse(r.reasons_json),
  explanation: r.explanation,
  status: r.status,
  createdAtMs: r.created_at_ms,
  expiresAtMs: r.expires_at_ms,
  decidedAtMs: r.decided_at_ms ?? undefined,
  result: r.result_json ? JSON.parse(r.result_json) : undefined,
  error: r.error ?? undefined,
});

export class ApprovalStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    ensureApprovalSchema(db);
  }

  /** Re-uses a still-pending approval for the identical call, so an agent retry loop does not flood the owner. */
  createOrReuse(a: { agentId: string; tool: string; args: Record<string, unknown>; callHash: string; mandateToken: string; mandateId: string; reasons: Reason[]; explanation: string; ttlMs: number }): { approval: Approval; reused: boolean } {
    this.expireStale();
    const existing = this.db.prepare("SELECT * FROM approvals WHERE agent_id = ? AND call_hash = ? AND status = 'pending'").get(a.agentId, a.callHash) as Row | undefined;
    if (existing) return { approval: toApproval(existing), reused: true };
    const id = `apr_${randomUUID()}`;
    const t = this.now();
    this.db
      .prepare(
        "INSERT INTO approvals (id, agent_id, tool, args_json, call_hash, mandate_token, mandate_id, reasons_json, explanation, status, created_at_ms, expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)",
      )
      .run(id, a.agentId, a.tool, canonicalize(a.args), a.callHash, a.mandateToken, a.mandateId, canonicalize(a.reasons), a.explanation, t, t + a.ttlMs);
    return { approval: this.get(id)!, reused: false };
  }

  get(id: string): Approval | undefined {
    this.expireStale();
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  /** The agent's own mandate token for this approval (needed to re-run the guard on approval). */
  mandateTokenOf(id: string): string | undefined {
    return (this.db.prepare("SELECT mandate_token FROM approvals WHERE id = ?").get(id) as { mandate_token: string } | undefined)?.mandate_token;
  }

  list(status?: ApprovalStatus): Approval[] {
    this.expireStale();
    const rows = (status
      ? this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at_ms DESC LIMIT 200").all(status)
      : this.db.prepare("SELECT * FROM approvals ORDER BY created_at_ms DESC LIMIT 200").all()) as Row[];
    return rows.map(toApproval);
  }

  countPending(agentId?: string): number {
    this.expireStale();
    const row = (agentId
      ? this.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' AND agent_id = ?").get(agentId)
      : this.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get()) as { n: number };
    return row.n;
  }

  /** Atomically claims a pending approval for execution. False if it was already decided, or expired. */
  claim(id: string): boolean {
    this.expireStale();
    return this.db.prepare("UPDATE approvals SET status = 'approving', decided_at_ms = ? WHERE id = ? AND status = 'pending'").run(this.now(), id).changes === 1;
  }

  settle(id: string, status: "executed" | "failed" | "denied", extra: { result?: unknown; error?: string } = {}): void {
    this.db
      .prepare("UPDATE approvals SET status = ?, decided_at_ms = COALESCE(decided_at_ms, ?), result_json = ?, error = ? WHERE id = ? AND status IN ('pending','approving')")
      .run(status, this.now(), extra.result === undefined ? null : JSON.stringify(extra.result), extra.error ?? null, id);
  }

  private expireStale(): void {
    this.db.prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at_ms <= ?").run(this.now());
  }
}
