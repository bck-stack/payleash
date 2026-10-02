import { formatMinor, type Money } from "../money.js";
import type { Decision, Reason } from "../policy/types.js";
import { groupReasons, reasonInfo, type HumanReason } from "../reasons.js";
import type { ActionOrigin, AttackKind, BacktestAction } from "./actions.js";

export interface ActionFacts {
  amount?: Money;
  payeeEmail?: string;
  originalBuyerEmail?: string;
  /** ISO time of the order/capture. */
  transactionTime?: string;
}

/** The outcome of one replayed action. The firewall's and the policy's verdicts are kept apart so the policy can be re-run alone. */
export interface ActionResult {
  action: BacktestAction;
  decision: Decision;
  reasons: HumanReason[];
  rawReasons: Reason[];
  facts: ActionFacts;
  taint: { decision: Decision; reasons: Reason[] };
  policy: { decision: Decision; reasons: Reason[] };
  /** For injected cases: it was stopped (anything but allow). */
  caught?: boolean;
}

export interface DecisionCounts {
  actions: number;
  allow: number;
  hold: number;
  deny: number;
}

export interface MoneyTotals {
  /** Amount of the calls that would have run on their own. */
  allowedMinor: number;
  heldMinor: number;
  deniedMinor: number;
  allowed: string;
  held: string;
  denied: string;
}

export interface RuleHit {
  code: string;
  title: string;
  /** Actions in which this rule fired (an action counts once per rule). */
  actions: number;
  deny: number;
  hold: number;
}

export interface BacktestReport {
  totals: DecisionCounts;
  money: Record<string, MoneyTotals>;
  byOrigin: Record<ActionOrigin, DecisionCounts>;
  ruleHits: RuleHit[];
  adversarial: {
    total: number;
    caught: number;
    /** Injected cases that would have run on their own. Anything here is a hole in the policy. */
    missed: { id: string; label: string }[];
    injections: { total: number; caught: number };
    byKind: Partial<Record<AttackKind, { total: number; caught: number }>>;
  };
  timeline: { date: string; allow: number; hold: number; deny: number }[];
  /** Calls by size (of the amount at stake) and outcome. */
  sizes: { bucket: string; allow: number; hold: number; deny: number }[];
}

const empty = (): DecisionCounts => ({ actions: 0, allow: 0, hold: 0, deny: 0 });
const BUCKETS: [string, number][] = [["< 10", 1000], ["10 - 25", 2500], ["25 - 50", 5000], ["50 - 100", 10000], ["100 +", Infinity]];

export function summarize(results: readonly ActionResult[]): BacktestReport {
  const totals = empty();
  const byOrigin = { refund: empty(), dispute: empty(), sampled: empty(), adversarial: empty() } as Record<ActionOrigin, DecisionCounts>;
  const moneyMinor = new Map<string, { allowed: number; held: number; denied: number }>();
  const hits = new Map<string, RuleHit>();
  const timeline = new Map<string, { date: string; allow: number; hold: number; deny: number }>();
  const sizes = BUCKETS.map(([bucket]) => ({ bucket, allow: 0, hold: 0, deny: 0 }));
  const adv = { total: 0, caught: 0, missed: [] as { id: string; label: string }[], injections: { total: 0, caught: 0 }, byKind: {} as Partial<Record<AttackKind, { total: number; caught: number }>> };

  for (const r of results) {
    const d = r.decision;
    for (const c of [totals, byOrigin[r.action.origin]]) {
      c.actions++;
      c[d]++;
    }
    const amount = r.facts.amount;
    if (amount) {
      const m = moneyMinor.get(amount.currency) ?? { allowed: 0, held: 0, denied: 0 };
      if (d === "allow") m.allowed += amount.minor;
      else if (d === "hold") m.held += amount.minor;
      else m.denied += amount.minor;
      moneyMinor.set(amount.currency, m);
      const idx = BUCKETS.findIndex(([, hi]) => amount.minor < hi);
      sizes[idx]![d]++;
    }
    for (const reason of groupReasons(r.rawReasons)) {
      const h = hits.get(reason.code) ?? { code: reason.code, title: reasonInfo(reason.code).title, actions: 0, deny: 0, hold: 0 };
      h.actions++;
      if (d === "deny") h.deny++;
      if (d === "hold") h.hold++;
      hits.set(reason.code, h);
    }
    const day = r.action.at.slice(0, 10);
    const t = timeline.get(day) ?? { date: day, allow: 0, hold: 0, deny: 0 };
    t[d]++;
    timeline.set(day, t);

    if (r.action.attack) {
      const caught = d !== "allow";
      adv.total++;
      if (caught) adv.caught++;
      else adv.missed.push({ id: r.action.id, label: r.action.label });
      const k = (adv.byKind[r.action.attack.kind] ??= { total: 0, caught: 0 });
      k.total++;
      if (caught) k.caught++;
      if (r.action.attack.kind === "prompt_injection") {
        adv.injections.total++;
        if (caught) adv.injections.caught++;
      }
    }
  }

  const money: BacktestReport["money"] = {};
  for (const [cur, m] of moneyMinor) {
    money[cur] = { allowedMinor: m.allowed, heldMinor: m.held, deniedMinor: m.denied, allowed: formatMinor(m.allowed, cur), held: formatMinor(m.held, cur), denied: formatMinor(m.denied, cur) };
  }
  return {
    totals,
    money,
    byOrigin,
    ruleHits: [...hits.values()].sort((a, b) => b.actions - a.actions || a.code.localeCompare(b.code)),
    adversarial: adv,
    timeline: [...timeline.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sizes,
  };
}

/** Flat rows for the dashboard's AG Grid. */
export interface ReportRow {
  id: string;
  at: string;
  origin: ActionOrigin;
  label: string;
  tool: string;
  orderId: string;
  amount: number | null;
  currency: string;
  decision: Decision;
  rules: string;
  attack: string;
  caught: boolean | null;
  explanation: string;
}

export function toRows(results: readonly ActionResult[]): ReportRow[] {
  return results.map((r) => ({
    id: r.action.id,
    at: r.action.at,
    origin: r.action.origin,
    label: r.action.label,
    tool: r.action.tool,
    orderId: r.action.orderId ?? "",
    amount: r.facts.amount ? r.facts.amount.minor / 10 ** (r.facts.amount.currency === "JPY" || r.facts.amount.currency === "HUF" || r.facts.amount.currency === "TWD" ? 0 : 2) : null,
    currency: r.facts.amount?.currency ?? "",
    decision: r.decision,
    rules: r.reasons.map((x) => x.code).join(", "),
    attack: r.action.attack ? `${r.action.attack.kind}: ${r.action.attack.variant}` : "",
    caught: r.action.attack ? r.decision !== "allow" : null,
    explanation: r.reasons[0]?.message ?? (r.decision === "allow" ? "Within the mandate and confirmed by PayPal's records." : ""),
  }));
}
