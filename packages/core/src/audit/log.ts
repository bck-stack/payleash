import { canonicalize, sha256Hex } from "../canonical.js";
import type { Db } from "../db.js";
import type { Reason } from "../policy/types.js";

export const GENESIS_HASH = "0".repeat(64);

/**
 * What happened. `allow | hold | deny` are the pipeline's decisions; the rest record what followed.
 * A call that was allowed gets a second entry (`executed` / `execution_failed`) carrying the PayPal result id.
 */
export type AuditDecision = "allow" | "hold" | "deny" | "approve" | "reject" | "executed" | "execution_failed";

export interface AuditEntryInput {
  agent: string;
  tool: string;
  args: unknown;
  decision: AuditDecision;
  reasons?: Reason[];
  mandateId?: string;
  paypalResultId?: string;
  ts?: Date;
}

export interface AuditEntry {
  seq: number;
  ts: string;
  agent: string;
  tool: string;
  /** Canonical JSON. */
  args: string;
  decision: AuditDecision;
  /** Canonical JSON. */
  reasons: string;
  mandateId: string | null;
  paypalResultId: string | null;
  prevHash: string;
  hash: string;
}

export interface VerifyProblem {
  seq: number;
  problem: "bad_sequence" | "bad_prev_hash" | "bad_hash" | "unparseable";
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  headSeq: number;
  headHash: string;
  problems: VerifyProblem[];
}

type Row = {
  seq: number;
  ts: string;
  agent: string;
  tool: string;
  args: string;
  decision: AuditDecision;
  reasons: string;
  mandate_id: string | null;
  paypal_result_id: string | null;
  prev_hash: string;
  hash: string;
};

const toEntry = (r: Row): AuditEntry => ({
  seq: r.seq,
  ts: r.ts,
  agent: r.agent,
  tool: r.tool,
  args: r.args,
  decision: r.decision,
  reasons: r.reasons,
  mandateId: r.mandate_id,
  paypalResultId: r.paypal_result_id,
  prevHash: r.prev_hash,
  hash: r.hash,
});

/** hash = SHA-256(canonical JSON of every field of the entry, including prevHash). */
export function entryHash(e: Omit<AuditEntry, "hash">): string {
  return sha256Hex(
    canonicalize({
      seq: e.seq,
      ts: e.ts,
      agent: e.agent,
      tool: e.tool,
      args: e.args,
      decision: e.decision,
      reasons: e.reasons,
      mandateId: e.mandateId,
      paypalResultId: e.paypalResultId,
      prevHash: e.prevHash,
    }),
  );
}

/**
 * Append-only audit log with a SHA-256 hash chain, stored in SQLite.
 * SQLite triggers refuse UPDATE/DELETE (guards against accidents); the chain detects deliberate edits,
 * including by someone who drops the triggers. Truncation of the tail is only detectable against a head hash
 * recorded elsewhere: pass it as `expectedHead` to `verify` (`payleash audit head` prints it).
 */
export class AuditLog {
  constructor(private readonly db: Db) {}

  append(input: AuditEntryInput): AuditEntry {
    const tx = this.db.transaction((): AuditEntry => {
      const last = this.db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
      const partial: Omit<AuditEntry, "hash"> = {
        seq: (last?.seq ?? 0) + 1,
        ts: (input.ts ?? new Date()).toISOString(),
        agent: input.agent,
        tool: input.tool,
        args: canonicalize(input.args ?? {}),
        decision: input.decision,
        reasons: canonicalize(input.reasons ?? []),
        mandateId: input.mandateId ?? null,
        paypalResultId: input.paypalResultId ?? null,
        prevHash: last?.hash ?? GENESIS_HASH,
      };
      const entry: AuditEntry = { ...partial, hash: entryHash(partial) };
      this.db
        .prepare(
          "INSERT INTO audit_log (seq, ts, agent, tool, args, decision, reasons, mandate_id, paypal_result_id, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(entry.seq, entry.ts, entry.agent, entry.tool, entry.args, entry.decision, entry.reasons, entry.mandateId, entry.paypalResultId, entry.prevHash, entry.hash);
      return entry;
    });
    return tx.immediate();
  }

  entries(opts: { limit?: number; agent?: string } = {}): AuditEntry[] {
    const rows = (
      opts.agent
        ? this.db.prepare("SELECT * FROM audit_log WHERE agent = ? ORDER BY seq DESC LIMIT ?").all(opts.agent, opts.limit ?? 1000)
        : this.db.prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?").all(opts.limit ?? 1000)
    ) as Row[];
    return rows.reverse().map(toEntry);
  }

  head(): { seq: number; hash: string } {
    const last = this.db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
    return last ?? { seq: 0, hash: GENESIS_HASH };
  }

  /** Recomputes the whole chain. `expectedHead` (hash) additionally detects deleted tail entries. */
  verify(opts: { expectedHead?: string } = {}): VerifyResult {
    const problems: VerifyProblem[] = [];
    const add = (p: VerifyProblem) => problems.length < 50 && problems.push(p);
    let prevSeq = 0;
    let prevHash = GENESIS_HASH;
    let count = 0;
    for (const row of this.db.prepare("SELECT * FROM audit_log ORDER BY seq").iterate() as Iterable<Row>) {
      count++;
      const e = toEntry(row);
      if (e.seq !== prevSeq + 1) add({ seq: e.seq, problem: "bad_sequence", message: `expected seq ${prevSeq + 1}, found ${e.seq} (an entry was deleted or inserted)` });
      if (e.prevHash !== prevHash) add({ seq: e.seq, problem: "bad_prev_hash", message: "prev_hash does not match the previous entry's hash" });
      try {
        JSON.parse(e.args);
        JSON.parse(e.reasons);
      } catch {
        add({ seq: e.seq, problem: "unparseable", message: "args or reasons are not valid JSON" });
      }
      const { hash, ...rest } = e;
      if (entryHash(rest) !== hash) add({ seq: e.seq, problem: "bad_hash", message: "entry content does not match its hash (the row was modified)" });
      prevSeq = e.seq;
      prevHash = e.hash;
    }
    if (opts.expectedHead && opts.expectedHead !== prevHash) {
      add({ seq: prevSeq, problem: "bad_hash", message: `head hash ${prevHash} differs from the expected head (entries were removed from the end, or added)` });
    }
    return { ok: problems.length === 0, entries: count, headSeq: prevSeq, headHash: prevHash, problems };
  }
}
