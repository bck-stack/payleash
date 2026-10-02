import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../api";
import { confirmDialog, toast } from "../components/feedback";
import { DecisionBadge, Empty, ErrorBox, Spinner } from "../components/ui";
import { useApp } from "../context";
import { clock, toolName } from "../format";
import { useLoad } from "../hooks";
import type { AgentCard, AuditRow, Overview as OverviewData } from "../types";

export function Overview({ onChange }: { onChange: () => void }) {
  const { me } = useApp();
  const tz = new Date().getTimezoneOffset();
  const o = useLoad<OverviewData>(() => api(`/api/overview?tz=${tz}`), [], 8000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (path: string, body: object = {}, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { body });
      o.reload();
      onChange();
      if (done) toast.success(done);
    } catch (e) {
      setError(errorText(e));
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const global = o.data?.frozen.global;
  const freezeAll = async () => {
    const ok = await confirmDialog({ title: "Freeze all agents?", body: "Every write call (refunds, invoices, ...) is denied immediately. Reads keep working. You can lift it again at any time.", confirmLabel: "Freeze all agents", danger: true });
    if (ok) await act("/api/freeze", { reason: "Kill switch pressed in the dashboard" }, "Kill switch ON: every agent is frozen.");
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>What each agent may do, how much of its budget it has used, and what is happening right now.</p>
        </div>
        {me.canFreeze && !global && (
          <button className="btn danger" onClick={() => void freezeAll()} disabled={busy}><span aria-hidden="true">❄</span> Kill switch: freeze all agents</button>
        )}
      </div>

      {global && (
        <div className="banner crit" role="alert">
          <span><strong>Kill switch is ON.</strong> Every agent is frozen: all write calls are denied.{global.reason ? ` Reason: ${global.reason}` : ""}</span>
          {me.canFreeze && <button className="btn" onClick={() => void act("/api/unfreeze", {}, "Kill switch lifted: agents can write again.")} disabled={busy}>Lift the kill switch</button>}
        </div>
      )}
      <ErrorBox message={error ?? o.error} onRetry={o.reload} />
      {me.demo && me.role && <DemoTools onDone={() => { o.reload(); onChange(); }} />}

      {o.loading && !o.data ? <Spinner /> : null}
      {o.data && o.data.agents.length === 0 && (
        <div className="card"><Empty title="No agents yet">An agent shows up here once it presents a mandate to the proxy, or once you issue one on the Policies page (<code>payleash mandate issue --record</code> from the CLI).</Empty></div>
      )}
      <div className="grid cols-2">
        {o.data?.agents.map((a) => <AgentCardView key={a.agentId} a={a} canFreeze={me.canFreeze} busy={busy} act={act} />)}
      </div>
      <Feed />
    </>
  );
}

function DemoTools({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="banner info small">
      <span>Demo mode: the agents' calls below were really decided by the guard, against recorded PayPal data.</span>
      <button className="btn small" disabled={busy} onClick={async () => { setBusy(true); try { await api("/api/demo/reseed", { body: {} }); onDone(); toast.success("Demo reset: fresh data and held calls."); } catch (e) { toast.error(errorText(e)); } finally { setBusy(false); } }}>
        Reset the demo
      </button>
    </div>
  );
}

function AgentCardView({ a, canFreeze, busy, act }: { a: AgentCard; canFreeze: boolean; busy: boolean; act: (p: string, b?: object, done?: string) => Promise<void> }) {
  const m = a.mandate;
  const tone = !m ? "muted" : m.state === "valid" ? (m.daysLeft <= 3 ? "warn" : "good") : "crit";
  return (
    <section className="card" aria-label={`Agent ${a.agentId}`}>
      <div className="agent-head">
        <div>
          <div className="agent-name">{a.agentId}</div>
          <div className="row small" style={{ gap: 6 }}>
            {!m && <span className="badge muted">No mandate</span>}
            {m && (
              <span className={`badge ${tone}`}>
                <span aria-hidden="true">{m.state === "valid" ? "✓" : "✕"}</span>
                {m.state === "valid" ? `Mandate valid, ${m.daysLeft} day${m.daysLeft === 1 ? "" : "s"} left` : m.state === "expired" ? "Mandate expired" : "Mandate not valid yet"}
              </span>
            )}
            {a.frozen && <span className="badge crit"><span aria-hidden="true">❄</span> Frozen{a.frozenScope === "global" ? " (all)" : ""}</span>}
          </div>
        </div>
        {a.pending > 0 && <Link to="/approvals" className="badge warn" style={{ textDecoration: "none" }}>‖ {a.pending} waiting</Link>}
      </div>

      {m && m.allowedTools.length > 0 && <p className="small ink2">May use: {m.allowedTools.filter((t) => m.constraints[t] || /refund|invoice|dispute|subscription/.test(t)).map(toolName).join(", ") || m.allowedTools.map(toolName).join(", ")}</p>}

      {a.budgets.length === 0 && m && <p className="small muted">No daily budget in this mandate.</p>}
      {a.budgets.map((b) => (
        <div key={b.tool} className="stack">
          <div className="row between small">
            <span>{toolName(b.tool)} budget, rolling 24 h</span>
            <span><strong>{b.used}</strong> / {b.limit} {b.currency}</span>
          </div>
          <div className={`bar ${b.percent >= 100 ? "full" : b.percent >= 80 ? "hot" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={b.percent} aria-label={`${toolName(b.tool)} budget used`}>
            <span style={{ width: `${Math.max(b.percent, b.percent > 0 ? 2 : 0)}%` }} />
          </div>
          <div className="small muted">{b.remaining} {b.currency} left ({b.percent}% used)</div>
        </div>
      ))}

      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>Today</div>
        <div className="counts">
          <div className="count"><b style={{ color: "var(--good-text)" }}>{a.today.allow}</b><span>✓ ran</span></div>
          <div className="count"><b style={{ color: "var(--warn-text)" }}>{a.today.hold}</b><span>‖ held</span></div>
          <div className="count"><b style={{ color: "var(--crit-text)" }}>{a.today.deny}</b><span>✕ denied</span></div>
        </div>
      </div>

      {canFreeze && a.frozenScope !== "global" && (
        <div className="row">
          {a.frozen ? (
            <button className="btn small" disabled={busy} onClick={() => void act("/api/unfreeze", { agentId: a.agentId }, `${a.agentId} unfrozen.`)}>Unfreeze {a.agentId}</button>
          ) : (
            <button className="btn small" disabled={busy} onClick={async () => { if (await confirmDialog({ title: `Freeze ${a.agentId}?`, body: "All its write calls are denied until you unfreeze it. Other agents keep working.", confirmLabel: `Freeze ${a.agentId}`, danger: true })) void act("/api/freeze", { agentId: a.agentId, reason: "Frozen in the dashboard" }, `${a.agentId} is frozen.`); }}>
              ❄ Freeze this agent
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Live activity: the newest audit entries, kept current by server-sent events (polling when the stream is unavailable). */
function Feed() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const last = useRef(0);

  const add = useCallback((incoming: AuditRow[], animate: boolean) => {
    if (!incoming.length) return;
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.seq));
      const merged = [...incoming.filter((r) => !seen.has(r.seq)), ...prev].sort((a, b) => b.seq - a.seq).slice(0, 60);
      return merged;
    });
    last.current = Math.max(last.current, ...incoming.map((r) => r.seq));
    if (animate) {
      setFresh((f) => new Set([...f, ...incoming.map((r) => r.seq)]));
      setTimeout(() => setFresh((f) => { const n = new Set(f); incoming.forEach((r) => n.delete(r.seq)); return n; }), 2500);
    }
  }, []);

  useEffect(() => {
    let es: EventSource | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    api<{ entries: AuditRow[] }>("/api/audit?limit=40")
      .then((r) => {
        if (stopped) return;
        add([...r.entries].reverse(), false);
        if (typeof EventSource === "undefined") throw new Error("no EventSource");
        es = new EventSource(`/api/events?afterSeq=${last.current}`);
        es.onopen = () => setLive(true);
        es.onerror = () => setLive(false);
        es.addEventListener("audit", (ev) => add([JSON.parse((ev as MessageEvent).data) as AuditRow], true));
      })
      .catch((e) => {
        if (stopped) return;
        setError(errorText(e));
        poll = setInterval(() => api<{ entries: AuditRow[] }>(`/api/audit?afterSeq=${last.current}`).then((r) => add([...r.entries].reverse(), true)).catch(() => {}), 4000);
      });
    return () => {
      stopped = true;
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [add]);

  return (
    <section className="card" aria-label="Live activity">
      <div className="row between">
        <h2>Live activity</h2>
        <span className="row small muted" style={{ gap: 6 }}><span className={`live-dot ${live ? "on" : ""}`} aria-hidden="true" />{live ? "Live" : "Reconnecting…"}</span>
      </div>
      <ErrorBox message={error} />
      {rows.length === 0 ? (
        <Empty title="Nothing yet">Decisions appear here as agents call PayPal through PayLeash.</Empty>
      ) : (
        <ol className="feed" aria-live="polite">
          {rows.map((r) => (
            <li key={r.seq} className={fresh.has(r.seq) ? "fresh" : ""}>
              <DecisionBadge decision={r.decision} />
              <div style={{ minWidth: 0 }}>
                <div><strong>{r.agent}</strong> · {toolName(r.tool)}{r.summary ? <span className="ink2"> · {r.summary}</span> : null}</div>
                {r.reasonsGrouped[0] && ["hold", "deny"].includes(r.decision) && (
                  <div className="small ink2">{r.reasonsGrouped[0].title}{r.reasonsGrouped.length > 1 ? ` (+${r.reasonsGrouped.length - 1} more)` : ""}</div>
                )}
                {r.paypalResultId && <div className="small muted mono">PayPal {r.paypalResultId}</div>}
              </div>
              <span className="when">{clock(r.ts)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
