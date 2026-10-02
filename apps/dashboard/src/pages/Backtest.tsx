import type { ColDef, ICellRendererParams, RowClassParams } from "ag-grid-community";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { MoneyBars, RuleBars, WeeklyDecisions } from "../components/Charts";
import { Grid, type GridApi } from "../components/Grid";
import { toast } from "../components/feedback";
import { DecisionBadge, ErrorBox, Spinner, Stat } from "../components/ui";
import { useApp } from "../context";
import { dateTime, money, toolName } from "../format";
import { useLoad } from "../hooks";
import type { BacktestReport, BacktestRow, BacktestRun, Decision, MandateInput, WhatIf } from "../types";

interface Defaults {
  sources: { fixtures: boolean; live: boolean };
  agents: { agentId: string; mandate: MandateInput }[];
  defaultMandate: MandateInput;
}
type Row = BacktestRow & { baseline: Decision };

const Badge = (p: ICellRendererParams<Row>) => (p.value ? <span className="badge-cell"><DecisionBadge decision={p.value} /></span> : null);
const ORIGIN: Record<string, string> = { refund: "From a real refund", dispute: "From a dispute", sampled: "Customer request (sampled)", adversarial: "Injected attack" };

export function Backtest() {
  const { me } = useApp();
  const [params] = useSearchParams();
  const defaults = useLoad<Defaults>(() => api("/api/backtest/defaults"), []);
  const [source, setSource] = useState<"fixtures" | "live">("fixtures");
  const [mandateKey, setMandateKey] = useState("example");
  const [sample, setSample] = useState(40);
  const [attacks, setAttacks] = useState(true);
  const [run, setRun] = useState<BacktestRun | null>(null);
  const [what, setWhat] = useState<WhatIf | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gridApi = useRef<GridApi<Row> | null>(null);
  const seq = useRef(0);

  const draft = useMemo<MandateInput | null>(() => {
    try {
      const s = sessionStorage.getItem("payleash-backtest-draft");
      return s ? (JSON.parse(s) as MandateInput) : null;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    if (params.get("draft") && draft) setMandateKey("draft");
    else if (defaults.data && mandateKey === "example") {
      // The backtest replays refund requests, so start with an agent that is allowed to refund.
      const refunder = defaults.data.agents.find((a) => a.mandate.allowedTools.includes("create_refund"));
      if (refunder) setMandateKey(`agent:${refunder.agentId}`);
    }
  }, [defaults.data]);

  const mandateFor = (key: string): MandateInput | undefined =>
    key === "draft" ? draft ?? undefined : key.startsWith("agent:") ? defaults.data?.agents.find((a) => a.agentId === key.slice(6))?.mandate : defaults.data?.defaultMandate;

  const start = async () => {
    setBusy(true);
    setError(null);
    setWhat(null);
    try {
      const m = mandateFor(mandateKey);
      const r = await api<BacktestRun>("/api/backtest/run", { body: { source, mandate: m, sampleOrders: sample, adversarial: attacks } });
      setRun(r);
      setThreshold(r.thresholdDefault ? Number(r.thresholdDefault) : 25);
      toast.success("Backtest finished: the policy was replayed through the guard.");
    } catch (e) {
      setError(errorText(e));
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // What-if: the slider re-runs the policy only, on the server, in memory. Stale answers are dropped.
  const baseThreshold = run?.thresholdDefault ? Number(run.thresholdDefault) : null;
  useEffect(() => {
    if (!run || threshold === null) return;
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api<WhatIf>("/api/backtest/whatif", { body: { runId: run.id, autoApproveThreshold: threshold.toFixed(2) } })
        .then((w) => mine === seq.current && setWhat(w))
        .catch((e) => mine === seq.current && setError(errorText(e)));
    }, 140);
    return () => clearTimeout(t);
  }, [run, threshold]);

  const report: BacktestReport | undefined = what?.report ?? run?.report;
  const base = run?.report;
  const cur = Object.keys(report?.money ?? {})[0] ?? "USD";
  const delta = (a: number, b: number) => (a === b ? "no change" : `${a > b ? "+" : ""}${a - b} vs the current limit`);
  const maxSlider = Math.max(150, Math.ceil(((run?.maxPerOp ? Number(run.maxPerOp) : 100) * 1.5) / 25) * 25);

  const rows = useMemo<Row[]>(() => (run?.rows ?? []).map((r) => ({ ...r, baseline: r.decision, decision: what?.decisions[r.id]?.decision ?? r.decision, rules: what?.decisions[r.id]?.rules ?? r.rules, caught: r.attack ? (what?.decisions[r.id]?.decision ?? r.decision) !== "allow" : null })), [run, what]);
  const cols = useMemo<ColDef<Row>[]>(
    () => [
      { field: "id", headerName: "#", width: 90 },
      { field: "at", headerName: "When", width: 160, filter: "agTextColumnFilter", valueFormatter: (p) => (p.value ? dateTime(p.value) : "") },
      { field: "origin", width: 190, valueFormatter: (p) => ORIGIN[p.value] ?? p.value },
      { field: "label", headerName: "Request", flex: 1, minWidth: 320 },
      { field: "amount", width: 120, type: "numericColumn", filter: "agNumberColumnFilter", valueFormatter: (p) => (p.value === null || p.value === undefined ? "" : money(p.value, p.data?.currency || "USD")) },
      { field: "decision", headerName: "Outcome", width: 150, cellRenderer: Badge, filterValueGetter: (p) => p.data?.decision },
      { field: "baseline", headerName: "With current limit", width: 170, cellRenderer: Badge },
      { field: "rules", headerName: "Rules that fired", minWidth: 240, flex: 1 },
      { field: "attack", headerName: "Attack", minWidth: 200, valueFormatter: (p) => (p.value ? toolName(String(p.value).replace(":", " ·")) : "") },
      { field: "caught", headerName: "Stopped?", width: 120, valueFormatter: (p) => (p.value === null ? "" : p.value ? "✓ yes" : "✕ NO") },
    ],
    [],
  );

  const adv = report?.adversarial;
  const moneyNow = report?.money[cur];
  const moneyBase = base?.money[cur];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Backtest</h1>
          <p>Replay your policy on 90 days of history before you trust it. It runs through the same guard as live calls, in dry-run mode: nothing is ever sent to PayPal.</p>
        </div>
      </div>

      <section className="card" aria-label="Run a backtest">
        <div className="grid cols-3">
          <label>
            History
            <select value={source} onChange={(e) => setSource(e.target.value as "fixtures" | "live")}>
              <option value="fixtures" disabled={defaults.data ? !defaults.data.sources.fixtures : false}>Recorded 90 days (200 orders)</option>
              <option value="live" disabled={!defaults.data?.sources.live || me.role === "demo"}>Live sandbox (Transaction Search + Disputes){!defaults.data?.sources.live ? " (needs sandbox credentials)" : ""}</option>
            </select>
          </label>
          <label>
            Policy to test
            <select value={mandateKey} onChange={(e) => setMandateKey(e.target.value)}>
              {defaults.data?.agents.filter((a) => a.mandate.allowedTools.includes("create_refund")).map((a) => <option key={a.agentId} value={`agent:${a.agentId}`}>Current mandate of {a.agentId}</option>)}
              {draft && <option value="draft">Draft from the Policies page ({draft.agentId})</option>}
              <option value="example">Example support agent</option>
            </select>
          </label>
          <label>
            Sampled customer requests: {sample}
            <input type="range" min={0} max={120} step={10} value={sample} onChange={(e) => setSample(Number(e.target.value))} />
          </label>
        </div>
        <div className="row">
          <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" checked={attacks} onChange={(e) => setAttacks(e.target.checked)} /> Add attack cases (prompt injections, over-limit, old order, bursts)</label>
          <span className="spacer" />
          <button className="btn primary" onClick={() => void start()} disabled={busy || !defaults.data}>{busy ? "Replaying…" : run ? "Run again" : "Run the backtest"}</button>
        </div>
        <ErrorBox message={error} />
        {busy && <Spinner label="Replaying through the guard" />}
      </section>

      {run && report && base && (
        <>
          <section className="card slider-card" aria-label="What if the threshold were different">
            <div className="row between">
              <h2>What if your auto-approve limit were {money(threshold ?? 0, cur)}?</h2>
              {baseThreshold !== null && threshold !== baseThreshold && <button className="btn small" onClick={() => setThreshold(baseThreshold)}>Back to {money(baseThreshold, cur)}</button>}
            </div>
            <input type="range" min={0} max={maxSlider} step={5} value={threshold ?? 0} onChange={(e) => setThreshold(Number(e.target.value))} aria-label="Auto-approve limit" aria-valuetext={money(threshold ?? 0, cur)} />
            <p className="small ink2">Moves the line between "runs on its own" and "waits for you". Only the policy is re-run, in memory, so it is instant. The firewall's verdicts, and the per-operation and daily limits, do not change.</p>
          </section>

          <div className="grid cols-3">
            <Stat label="Requests replayed" value={report.totals.actions} detail={`${run.source === "fixtures" ? "Recorded history" : "Live sandbox"}, ${run.days} days · dry run`} />
            <Stat label="✓ Would run on their own" value={report.totals.allow} tone="good" detail={delta(report.totals.allow, base.totals.allow)} />
            <Stat label="‖ Would wait for you" value={report.totals.hold} tone="warn" detail={delta(report.totals.hold, base.totals.hold)} />
            <Stat label="✕ Would be denied" value={report.totals.deny} tone="crit" detail={delta(report.totals.deny, base.totals.deny)} />
            <Stat label="Money moved automatically" value={money(moneyNow?.allowed ?? 0, cur)} detail={moneyBase && moneyNow && moneyBase.allowedMinor !== moneyNow.allowedMinor ? `was ${money(moneyBase.allowed, cur)}` : "same as the current limit"} />
            <Stat label="Money held for approval" value={money(moneyNow?.held ?? 0, cur)} detail={moneyBase && moneyNow && moneyBase.heldMinor !== moneyNow.heldMinor ? `was ${money(moneyBase.held, cur)}` : "same as the current limit"} />
          </div>

          <section className="card" aria-label="Attack cases">
            <div className="row between">
              <h2>Injection and attack cases</h2>
              {adv && adv.total > 0 && (
                <span className={`badge ${adv.missed.length ? "crit" : "good"}`} style={{ fontSize: "0.95rem", padding: "6px 14px" }}>
                  <span aria-hidden="true">{adv.missed.length ? "✕" : "✓"}</span> {adv.caught} of {adv.total} stopped
                </span>
              )}
            </div>
            {!adv || adv.total === 0 ? <p className="small muted">No attack cases in this run.</p> : (
              <>
                <p className="small ink2">{adv.injections.caught} of {adv.injections.total} prompt-injection attempts were caught. Each one tries to move money using text that only a customer wrote.</p>
                {adv.missed.length > 0 && <div className="error" role="alert"><strong>These attacks would have run on their own:</strong><ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{adv.missed.map((m) => <li key={m.id}>{m.label}</li>)}</ul></div>}
                <table className="table"><thead><tr><th>Kind</th><th className="num">Stopped</th></tr></thead><tbody>
                  {Object.entries(adv.byKind).map(([k, v]) => <tr key={k}><td>{toolName(k)}</td><td className="num">{v.caught} / {v.total}</td></tr>)}
                </tbody></table>
              </>
            )}
          </section>

          <div className="grid cols-2">
            <section className="card" aria-label="Requests per week"><h2>What the requests turned into</h2><WeeklyDecisions timeline={report.timeline} /></section>
            <section className="card" aria-label="Money by outcome"><h2>Money by outcome</h2><MoneyBars money={moneyNow} currency={cur} /></section>
          </div>
          <section className="card" aria-label="Rules that fired"><h2>Which rules did the work</h2><RuleBars hits={report.ruleHits} /></section>

          <section className="card" aria-label="Every replayed request">
            <div className="row between">
              <h2>Every replayed request</h2>
              <button className="btn small" onClick={() => { gridApi.current?.exportDataAsCsv({ fileName: "payleash-backtest.csv" }); toast.info("Exported the table as CSV."); }}>Export CSV</button>
            </div>
            <Grid<Row> rowData={rows} columnDefs={cols} onGridReady={(e) => { gridApi.current = e.api; }} getRowId={(p) => p.data.id} pagination paginationPageSize={25} paginationPageSizeSelector={[25, 50, 100]}
              getRowClass={(p: RowClassParams<Row>) => (p.data && p.data.decision !== p.data.baseline ? "changed-row" : undefined)} />
            <p className="small muted">Rows that the slider moved are marked in the “With current limit” column.</p>
          </section>
        </>
      )}
    </>
  );
}
