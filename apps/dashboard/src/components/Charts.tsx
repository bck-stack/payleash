import { useState, type ReactNode } from "react";
import type { BacktestReport } from "../types";

/** Status colours (good / warning / critical): fixed, never reused for anything else, and always paired with a word or symbol. */
const C = { allow: "var(--good)", hold: "var(--warn)", deny: "var(--crit)" } as const;
const NAME = { allow: "✓ Ran on its own", hold: "‖ Held for approval", deny: "✕ Denied" } as const;
type Dec = keyof typeof C;

interface TipState {
  x: number;
  y: number;
  text: ReactNode;
}
function useTip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const bind = (text: ReactNode) => ({
    onPointerEnter: (e: React.PointerEvent) => setTip({ x: e.clientX, y: e.clientY, text }),
    onPointerMove: (e: React.PointerEvent) => setTip({ x: e.clientX, y: e.clientY, text }),
    onPointerLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent) => {
      const r = (e.target as Element).getBoundingClientRect();
      setTip({ x: r.left + r.width / 2, y: r.top, text });
    },
    onBlur: () => setTip(null),
  });
  const node = tip ? (
    <div className="tip" style={{ left: Math.min(tip.x + 12, window.innerWidth - 250), top: tip.y + 14 }} role="tooltip">
      {tip.text}
    </div>
  ) : null;
  return { bind, node };
}

export function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="legend" aria-label="Legend">
      {items.map((i) => (
        <span key={i.label}><i style={{ background: i.color }} aria-hidden="true" />{i.label}</span>
      ))}
    </div>
  );
}
const DEC_LEGEND = (Object.keys(C) as Dec[]).map((k) => ({ color: C[k], label: NAME[k] }));

const weekStart = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const short = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** Chart 1: what the agent's requests turned into, week by week (stacked columns). */
export function WeeklyDecisions({ timeline }: { timeline: BacktestReport["timeline"] }) {
  const { bind, node } = useTip();
  const weeks = new Map<string, Record<Dec, number>>();
  for (const t of timeline) {
    const w = weeks.get(weekStart(t.date)) ?? { allow: 0, hold: 0, deny: 0 };
    w.allow += t.allow;
    w.hold += t.hold;
    w.deny += t.deny;
    weeks.set(weekStart(t.date), w);
  }
  const data = [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b));
  const W = 640;
  const H = 220;
  const m = { l: 32, r: 8, t: 8, b: 26 };
  const max = Math.max(1, ...data.map(([, v]) => v.allow + v.hold + v.deny));
  const top = Math.ceil(max / 5) * 5 || 5;
  const bw = (W - m.l - m.r) / Math.max(1, data.length);
  const y = (v: number) => m.t + (H - m.t - m.b) * (1 - v / top);

  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Requests per week by outcome">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="tick" x1={m.l} x2={W - m.r} y1={y(top * f)} y2={y(top * f)} />
            <text x={m.l - 6} y={y(top * f) + 4} textAnchor="end">{Math.round(top * f)}</text>
          </g>
        ))}
        <line className="axis" x1={m.l} x2={W - m.r} y1={y(0)} y2={y(0)} />
        {data.map(([w, v], i) => {
          let acc = 0;
          const x = m.l + i * bw + bw * 0.15;
          const label = `Week of ${short(w)}: ${v.allow} ran, ${v.hold} held, ${v.deny} denied`;
          return (
            <g key={w} tabIndex={0} aria-label={label} {...bind(label)}>
              {(["allow", "hold", "deny"] as Dec[]).map((k) => {
                if (!v[k]) return null;
                const y1 = y(acc + v[k]);
                const y0 = y(acc);
                acc += v[k];
                return <rect key={k} x={x} y={y1} width={bw * 0.7} height={Math.max(0, y0 - y1)} fill={C[k]} rx={2} className="gap" />;
              })}
              {i % Math.ceil(data.length / 8) === 0 && <text x={x + bw * 0.35} y={H - 8} textAnchor="middle">{short(w)}</text>}
              <rect x={m.l + i * bw} y={m.t} width={bw} height={H - m.t - m.b} fill="transparent" />
            </g>
          );
        })}
      </svg>
      <Legend items={DEC_LEGEND} />
      <details className="data-table">
        <summary>Show as a table</summary>
        <table className="table"><thead><tr><th>Week of</th><th className="num">Ran</th><th className="num">Held</th><th className="num">Denied</th></tr></thead>
          <tbody>{data.map(([w, v]) => <tr key={w}><td>{short(w)}</td><td className="num">{v.allow}</td><td className="num">{v.hold}</td><td className="num">{v.deny}</td></tr>)}</tbody></table>
      </details>
      {node}
    </figure>
  );
}

/** Chart 2: money by outcome, one bar each, labelled directly. */
export function MoneyBars({ money, currency }: { money: BacktestReport["money"][string] | undefined; currency: string }) {
  const { bind, node } = useTip();
  const rows: { k: Dec; v: number; text: string }[] = [
    { k: "allow", v: money?.allowedMinor ?? 0, text: money?.allowed ?? "0.00" },
    { k: "hold", v: money?.heldMinor ?? 0, text: money?.held ?? "0.00" },
    { k: "deny", v: money?.deniedMinor ?? 0, text: money?.denied ?? "0.00" },
  ];
  const max = Math.max(1, ...rows.map((r) => r.v));
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox="0 0 640 150" role="img" aria-label={`Money by outcome in ${currency}`}>
        {rows.map((r, i) => {
          const w = Math.max(r.v ? 4 : 0, ((640 - 170 - 170) * r.v) / max);
          const label = `${NAME[r.k]}: ${Number(r.text).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${currency}`;
          return (
            <g key={r.k} transform={`translate(0 ${i * 46 + 6})`} tabIndex={0} aria-label={label} {...bind(label)}>
              <text x={0} y={22} style={{ fill: "var(--ink)", fontSize: 13 }}>{NAME[r.k]}</text>
              <rect x={170} y={4} width={w} height={26} rx={4} fill={C[r.k]} />
              <text x={170 + w + 8} y={22} style={{ fill: "var(--ink)", fontSize: 13, fontWeight: 600 }}>{Number(r.text).toLocaleString(undefined, { minimumFractionDigits: 2 })} {currency}</text>
            </g>
          );
        })}
      </svg>
      {node}
    </figure>
  );
}

/** Chart 3: which rules did the work. Deny and hold stacked, count at the end of each bar. */
export function RuleBars({ hits }: { hits: BacktestReport["ruleHits"] }) {
  const { bind, node } = useTip();
  const rows = hits.slice(0, 8);
  const max = Math.max(1, ...rows.map((r) => r.deny + r.hold));
  const rowH = 30;
  const H = Math.max(60, rows.length * rowH + 8);
  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 640 ${H}`} role="img" aria-label="How often each rule fired">
        {rows.map((r, i) => {
          const scale = (640 - 330) / max;
          const label = `${r.title}: fired in ${r.actions} requests (${r.deny} denied, ${r.hold} held)`;
          return (
            <g key={r.code} transform={`translate(0 ${i * rowH + 4})`} tabIndex={0} aria-label={label} {...bind(label)}>
              <text x={0} y={17} style={{ fill: "var(--ink)", fontSize: 12.5 }}>{r.title.length > 36 ? `${r.title.slice(0, 35)}…` : r.title}</text>
              <rect x={260} y={3} width={Math.max(r.deny ? 3 : 0, r.deny * scale)} height={20} rx={3} fill={C.deny} className="gap" />
              <rect x={260 + r.deny * scale} y={3} width={Math.max(r.hold ? 3 : 0, r.hold * scale)} height={20} rx={3} fill={C.hold} className="gap" />
              <text x={260 + (r.deny + r.hold) * scale + 8} y={17} style={{ fill: "var(--ink)", fontSize: 12.5, fontWeight: 600 }}>{r.actions}</text>
            </g>
          );
        })}
      </svg>
      <Legend items={[{ color: C.deny, label: "✕ In denied requests" }, { color: C.hold, label: "⏸ In held requests" }]} />
      <details className="data-table">
        <summary>Show as a table</summary>
        <table className="table"><thead><tr><th>Rule</th><th className="num">Requests</th><th className="num">Denied</th><th className="num">Held</th></tr></thead>
          <tbody>{hits.map((r) => <tr key={r.code}><td>{r.title} <span className="mono muted">{r.code}</span></td><td className="num">{r.actions}</td><td className="num">{r.deny}</td><td className="num">{r.hold}</td></tr>)}</tbody></table>
      </details>
      {node}
    </figure>
  );
}
