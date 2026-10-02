/** Side-by-side diff of two mandates, as pretty JSON with sorted keys, aligned line by line. */

export type DiffKind = "same" | "changed" | "added" | "removed";
export interface DiffRow {
  left: string | null;
  right: string | null;
  kind: DiffKind;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

export const prettyMandate = (m: unknown): string => JSON.stringify(sortKeys(m ?? {}), null, 2);

/** Longest-common-subsequence line diff; neighbouring removed + added lines are paired as one changed row. */
export function diffLines(a: string, b: string): DiffRow[] {
  const x = a ? a.split("\n") : [];
  const y = b ? b.split("\n") : [];
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { t: "same" | "del" | "add"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push({ t: "same", line: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ t: "del", line: x[i++]! });
    else ops.push({ t: "add", line: y[j++]! });
  }
  while (i < n) ops.push({ t: "del", line: x[i++]! });
  while (j < m) ops.push({ t: "add", line: y[j++]! });

  const rows: DiffRow[] = [];
  for (let k = 0; k < ops.length; ) {
    const op = ops[k]!;
    if (op.t === "same") {
      rows.push({ left: op.line, right: op.line, kind: "same" });
      k++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < ops.length && ops[k]!.t !== "same") (ops[k]!.t === "del" ? dels : adds).push(ops[k++]!.line);
    for (let p = 0; p < Math.max(dels.length, adds.length); p++) {
      const l = dels[p] ?? null;
      const r = adds[p] ?? null;
      rows.push({ left: l, right: r, kind: l !== null && r !== null ? "changed" : l !== null ? "removed" : "added" });
    }
  }
  return rows;
}

const LABEL: Record<string, string> = {
  maxAmountPerOp: "Most per operation",
  dailyTotal: "Daily total (rolling 24 h)",
  autoApproveThreshold: "Runs alone up to",
  orderAgeDays: "Order age (days)",
  payeeMustBeOriginalBuyer: "Payee must be the original buyer",
  currency: "Currency",
};

export interface FieldChange {
  scope: string;
  field: string;
  before: string;
  after: string;
}

import type { MandateInput } from "./types";
type MandateLike = MandateInput;

/** The same change in words: one row per changed setting. */
export function fieldChanges(current: MandateLike | null, proposed: MandateLike): FieldChange[] {
  const out: FieldChange[] = [];
  const show = (v: unknown) => (v === undefined ? "not set" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
  const curTools = new Set(current?.allowedTools ?? []);
  const newTools = new Set(proposed.allowedTools);
  for (const t of newTools) if (!curTools.has(t)) out.push({ scope: "Tools", field: t, before: current ? "not allowed" : "no mandate yet", after: "allowed" });
  for (const t of curTools) if (!newTools.has(t)) out.push({ scope: "Tools", field: t, before: "allowed", after: "not allowed" });
  const tools = new Set([...Object.keys(current?.constraints ?? {}), ...Object.keys(proposed.constraints ?? {})]);
  for (const t of tools) {
    const a = (current?.constraints?.[t] ?? {}) as Record<string, unknown>;
    const b = (proposed.constraints?.[t] ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push({ scope: t, field: LABEL[k] ?? k, before: show(a[k]), after: show(b[k]) });
    }
  }
  return out;
}
