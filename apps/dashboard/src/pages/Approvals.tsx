import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { toast } from "../components/feedback";
import { DecisionBadge, Empty, ErrorBox, Spinner } from "../components/ui";
import { useApp } from "../context";
import { dateTime, timeAgo, timeLeft, toolName } from "../format";
import { useLoad, useNow } from "../hooks";
import type { Approval, OwnerReason, ProvenanceEntry } from "../types";

const ORIGIN_TONE: Record<ProvenanceEntry["origin"], "good" | "warn" | "crit" | "muted"> = {
  paypal: "good",
  customer_email: "warn",
  support_ticket: "warn",
  dispute_message: "warn",
  web_page: "warn",
  untrusted_text: "warn",
  unknown: "muted",
};

export function Approvals({ onChange }: { onChange: () => void }) {
  const { me } = useApp();
  const [params] = useSearchParams();
  const focus = params.get("focus");
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const pending = useLoad<{ approvals: Approval[] }>(() => api("/api/approvals?status=pending"), [], 6000);
  const decided = useLoad<{ approvals: Approval[] }>(() => api("/api/approvals"), [tab], tab === "decided" ? 10000 : null);
  const now = useNow();

  const list = tab === "pending" ? pending.data?.approvals ?? [] : (decided.data?.approvals ?? []).filter((a) => a.status !== "pending_approval");
  const loading = tab === "pending" ? pending.loading && !pending.data : decided.loading && !decided.data;
  const done = () => {
    pending.reload();
    decided.reload();
    onChange();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p>Calls your agents wanted to make that PayLeash held for you. Nothing is sent to PayPal until you approve it.</p>
        </div>
        <div className="row" role="tablist" aria-label="Filter">
          <button role="tab" aria-selected={tab === "pending"} className={`btn small ${tab === "pending" ? "primary" : ""}`} onClick={() => setTab("pending")}>
            Waiting{pending.data ? ` (${pending.data.approvals.length})` : ""}
          </button>
          <button role="tab" aria-selected={tab === "decided"} className={`btn small ${tab === "decided" ? "primary" : ""}`} onClick={() => setTab("decided")}>Decided</button>
        </div>
      </div>
      <ErrorBox message={pending.error ?? decided.error} onRetry={() => { pending.reload(); decided.reload(); }} />
      {loading && <Spinner />}
      {!loading && list.length === 0 && (
        <div className="card"><Empty title={tab === "pending" ? "All clear" : "Nothing decided yet"}>{tab === "pending" ? "No agent is waiting for you." : "Approved and denied calls show up here."}</Empty></div>
      )}
      {list.map((a) => <ApprovalCard key={a.approvalId} a={a} now={now} focused={a.approvalId === focus} canDecide={me.canApprove} onDone={done} />)}
    </>
  );
}

function ApprovalCard({ a, now, focused, canDecide, onDone }: { a: Approval; now: number; focused: boolean; canDecide: boolean; onDone: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Approval | null>(null);
  const shown = result ?? a;
  const open = shown.status === "pending_approval";
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);

  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    setError(null);
    try {
      const r = await api<Approval>(`/api/approvals/${a.approvalId}`, { body: { decision } });
      setResult(r);
      onDone();
      if (r.status === "executed") toast.success(`Approved and executed: ${r.context?.summary ?? a.tool}`);
      else if (r.status === "denied") toast.info("Denied. The agent is told no.");
      else if (r.status === "failed") toast.error(`Approved, but not executed: ${r.error ?? "see the card"}`);
    } catch (e) {
      setError(errorText(e));
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const ctx = shown.context;
  const verifiedCount = ctx?.provenance.filter((p) => p.status === "verified").length ?? 0;
  const notVerified = (ctx?.provenance ?? []).filter((p) => p.status !== "verified");

  return (
    <article ref={ref} className={`card approval ${open ? "" : `done ${shown.status}`} ${focused ? "focus" : ""}`} aria-label={`Approval for ${a.agentId}`}>
      <div className="row between">
        <div className="row small" style={{ gap: 8 }}>
          <strong>{a.agentId}</strong>
          <span className="muted">wants to use</span>
          <span className="badge muted">{toolName(a.tool)}</span>
        </div>
        <span className="small muted" title={dateTime(a.createdAt)}>
          {timeAgo(a.createdAt, now)}{open ? ` · ${timeLeft(a.expiresAt, now)}` : ""}
        </span>
      </div>

      <p className="summary">{ctx?.summary ?? a.explanation}</p>

      {!open && (
        <div className="row">
          {shown.status === "executed" ? <DecisionBadge decision="executed" /> : shown.status === "denied" ? <DecisionBadge decision="reject" /> : <span className={`badge ${shown.status === "failed" ? "crit" : "muted"}`}>{shown.status === "failed" ? "Not executed" : shown.status}</span>}
          {shown.decidedAt && <span className="small muted">{dateTime(shown.decidedAt)}</span>}
          {typeof shown.result === "object" && shown.result && "id" in shown.result && <span className="small mono">PayPal {(shown.result as { id: string }).id}</span>}
          {shown.error && <span className="small" style={{ color: "var(--crit-text)" }}>{shown.error}</span>}
        </div>
      )}

      {ctx && ctx.facts.length > 0 && (
        <dl className="facts">
          {ctx.facts.map((f) => (<div key={f.label} style={{ display: "contents" }}><dt>{f.label}</dt><dd>{f.value}</dd></div>))}
        </dl>
      )}

      <div className="stack">
        <h2 className="h3">Where each value came from</h2>
        <p className="small ink2">
          {notVerified.length === 0
            ? "Every value in this call is confirmed by PayPal's own records."
            : `${verifiedCount} value${verifiedCount === 1 ? " is" : "s are"} confirmed by PayPal. ${notVerified.length} ${notVerified.length === 1 ? "is" : "are"} not: check ${notVerified.length === 1 ? "it" : "them"} before approving.`}
        </p>
        <ul className="prov">
          {(ctx?.provenance ?? []).map((p) => (
            <li key={p.path}>
              <span className="small muted">{p.roleLabel}</span>
              <span className="mono val">{p.value}</span>
              <span className={`badge ${ORIGIN_TONE[p.origin]}`}><span aria-hidden="true">{p.status === "verified" ? "✓" : p.status === "tainted" ? "⚠" : "?"}</span>{p.label}</span>
            </li>
          ))}
          {!ctx?.provenance.length && <li className="muted small">No checkable values in this call.</li>}
        </ul>
      </div>

      <div className="stack">
        <h2 className="h3">Why it was held</h2>
        <ul className="reasons">
          {shown.reasons.map((r) => <ReasonItem key={r.code} r={r} />)}
        </ul>
        <p className="small ink2">{shown.explanation}</p>
      </div>

      {error && <ErrorBox message={error} />}
      {open && canDecide && (
        <div className="decide">
          <button className="btn danger big" disabled={!!busy} onClick={() => void decide("deny")}>{busy === "deny" ? "Denying…" : <><span aria-hidden="true">✕</span> Deny</>}</button>
          <button className="btn good big" disabled={!!busy} onClick={() => void decide("approve")}>{busy === "approve" ? "Approving…" : <><span aria-hidden="true">✓</span> Approve</>}</button>
        </div>
      )}
      {open && !canDecide && <p className="small muted">This account cannot approve calls.</p>}
    </article>
  );
}

function ReasonItem({ r }: { r: OwnerReason }) {
  return (
    <li>
      <div className="row" style={{ gap: 8 }}>
        <strong>{r.title}</strong>
        {r.count > 1 && <span className="badge muted" title={`${r.count} values triggered this rule`}>×{r.count}</span>}
      </div>
      <div className="small ink2">{r.meaning}</div>
      <div className="small"><strong>What to do:</strong> {r.action}</div>
      <details>
        <summary>Technical detail</summary>
        <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          <li className="mono">{r.code}</li>
          {r.details.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      </details>
    </li>
  );
}
