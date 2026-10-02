import { canonicalize } from "../canonical.js";
import type { Db } from "../db.js";
import { MandateSchema, type Mandate } from "./schema.js";

type Row = { id: string; agent_id: string; claims_json: string; not_before: number; expires_at: number; first_seen_ms: number; source: "issued" | "seen" };

export interface KnownMandate {
  mandate: Mandate;
  source: "issued" | "seen";
  firstSeenMs: number;
}

/**
 * The mandates PayLeash knows about, so the dashboard can show what each agent is currently allowed to do.
 * Only the verified claims are stored. The signed token is the agent's credential and is never kept here.
 */
export class MandateRegistry {
  constructor(private readonly db: Db) {}

  /** `issued` (signed here) wins over `seen` (an agent presented it) for the same id. */
  record(mandate: Mandate, source: "issued" | "seen", nowMs: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO mandates (id, agent_id, claims_json, not_before, expires_at, first_seen_ms, source) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET source = CASE WHEN excluded.source = 'issued' THEN 'issued' ELSE mandates.source END`,
      )
      .run(mandate.id, mandate.agentId, canonicalize(mandate), mandate.notBefore, mandate.expiresAt, nowMs, source);
  }

  private toKnown(r: Row): KnownMandate {
    return { mandate: MandateSchema.parse(JSON.parse(r.claims_json)), source: r.source, firstSeenMs: r.first_seen_ms };
  }

  /** The mandate in force for an agent: the newest one that is valid now, else the newest one. */
  current(agentId: string, nowSec: number = Math.floor(Date.now() / 1000)): KnownMandate | undefined {
    const valid = this.db
      .prepare("SELECT * FROM mandates WHERE agent_id = ? AND not_before <= ? AND expires_at > ? ORDER BY not_before DESC LIMIT 1")
      .get(agentId, nowSec, nowSec) as Row | undefined;
    const row = valid ?? (this.db.prepare("SELECT * FROM mandates WHERE agent_id = ? ORDER BY not_before DESC LIMIT 1").get(agentId) as Row | undefined);
    return row ? this.toKnown(row) : undefined;
  }

  agentIds(): string[] {
    return (this.db.prepare("SELECT DISTINCT agent_id FROM mandates ORDER BY agent_id").all() as { agent_id: string }[]).map((r) => r.agent_id);
  }

  list(limit = 100): KnownMandate[] {
    return (this.db.prepare("SELECT * FROM mandates ORDER BY not_before DESC LIMIT ?").all(limit) as Row[]).map((r) => this.toKnown(r));
  }
}
