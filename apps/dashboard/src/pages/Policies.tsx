import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorText } from "../api";
import { ErrorBox, Spinner, copy } from "../components/ui";
import { useApp } from "../context";
import { diffLines, fieldChanges, prettyMandate } from "../diff";
import { dateTime } from "../format";
import { useLoad } from "../hooks";
import type { PoliciesInfo, PolicyDraft } from "../types";

const EXAMPLES = [
  "Support agent may refund up to $100 per order, at most $300 a day, automatically up to $25; only orders from the last 60 days",
  "Billing agent can send invoices up to $500 each, runs alone up to $100, $1,000 a day",
  "Support agent may refund up to €50 per order, only to the original buyer, automatically up to €10, orders within 30 days",
];

export function Policies() {
  const { me } = useApp();
  const info = useLoad<PoliciesInfo>(() => api("/api/policies"), []);
  const nav = useNavigate();
  const [text, setText] = useState("");
  const [agentId, setAgentId] = useState("");
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [ttl, setTtl] = useState("30d");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ token: string; mandate: { id: string; agentId: string; expiresAt: string } } | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = useMemo(() => (draft ? diffLines(draft.current ? prettyMandate(draft.current) : "", prettyMandate(draft.proposed)) : []), [draft]);
  const changes = useMemo(() => (draft ? fieldChanges(draft.current, draft.proposed) : []), [draft]);

  const makeDraft = async () => {
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const d = await api<PolicyDraft>("/api/policies/draft", { body: { text, agentId: agentId || undefined } });
      setDraft(d);
      setTtl(d.ttl);
    } catch (e) {
      setDraft(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const issue = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<NonNullable<typeof issued>>("/api/policies/issue", { body: { mandate: draft.proposed, ttl, confirm: true } });
      setIssued(r);
      info.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const cli = draft ? `payleash mandate issue --file mandate.json --ttl ${ttl} --record` : "";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Policies</h1>
          <p>Write what an agent may do in plain words. PayLeash drafts the signed mandate, shows you exactly what changes, and signs it only when you confirm.</p>
        </div>
      </div>

      <section className="card" aria-label="Write a policy">
        <h2>1. Say it in your own words</h2>
        <label>
          What may the agent do?
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={info.data?.example ?? EXAMPLES[0]} />
        </label>
        <div className="chips" aria-label="Examples">
          {EXAMPLES.map((ex) => <button key={ex} className="chip" type="button" onClick={() => setText(ex)}>{ex.length > 70 ? `${ex.slice(0, 68)}…` : ex}</button>)}
        </div>
        <div className="row">
          <label style={{ minWidth: 220, flex: "0 1 280px" }}>
            Agent (if the text does not name one)
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">From the text</option>
              {info.data?.agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.agentId}</option>)}
            </select>
          </label>
          <span className="spacer" />
          <span className="small muted">{info.data?.llm.configured ? `Language model: ${info.data.llm.provider}` : "No language model: rule-based reading for common sentences"}</span>
          <button className="btn primary" disabled={busy || text.trim().length < 5} onClick={() => void makeDraft()}>{busy && !draft ? "Drafting…" : "Draft the mandate"}</button>
        </div>
        <ErrorBox message={error} />
      </section>

      {draft && (
        <section className="card" aria-label="Review the draft">
          <div className="row between">
            <h2>2. Check what changes</h2>
            <span className={`badge ${draft.source === "llm" ? "info" : "muted"}`}>{draft.source === "llm" ? "Drafted by the language model, validated" : "Drafted by the rule-based reader"}</span>
          </div>
          {draft.warnings.map((w) => <div key={w} className="warnbox">{w}</div>)}
          {draft.notes.length > 0 && <ul className="small ink2" style={{ margin: 0, paddingLeft: 18 }}>{draft.notes.map((n) => <li key={n}>{n}</li>)}</ul>}

          <h3>In words</h3>
          {changes.length === 0 ? (
            <p className="small ink2">Nothing changes: this is the mandate already in force.</p>
          ) : (
            <table className="table">
              <thead><tr><th>Setting</th><th>Now</th><th>Proposed</th></tr></thead>
              <tbody>
                {changes.map((c, i) => (
                  <tr key={i}><td><span className="muted">{c.scope}:</span> {c.field}</td><td>{c.before}</td><td><strong>{c.after}</strong></td></tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Side by side</h3>
          <div className="diff" role="group" aria-label="Current mandate next to the proposed mandate">
            <div className="h">Current mandate{draft.current ? "" : " (none yet)"}</div>
            <div className="h">Proposed</div>
            {rows.map((r, i) => (
              <div key={i} style={{ display: "contents" }}>
                <div className={`cell ${r.left === null ? "empty" : r.kind === "changed" ? "changed" : r.kind === "removed" ? "removed" : ""}`}>{r.left ?? " "}</div>
                <div className={`cell ${r.right === null ? "empty" : r.kind === "changed" ? "changed" : r.kind === "added" ? "added" : ""}`}>{r.right ?? " "}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {draft && !issued && (
        <section className="card" aria-label="Confirm">
          <h2>3. Confirm and sign</h2>
          <p className="small ink2">Nothing has been signed yet. Signing issues a new mandate with your owner key. The agent keeps working with its old mandate until you give it the new one.</p>
          <div className="row">
            <label style={{ width: 160 }}>
              Valid for
              <select value={ttl} onChange={(e) => setTtl(e.target.value)}>
                {[...new Set([draft.ttl, "1d", "7d", "30d", "90d"])].map((t) => <option key={t} value={t}>{t.replace("d", " days")}</option>)}
              </select>
            </label>
            <span className="spacer" />
            <button className="btn" onClick={() => { sessionStorage.setItem("payleash-backtest-draft", JSON.stringify(draft.proposed)); nav("/backtest?draft=1"); }}>Try it on the last 90 days first</button>
            <button className="btn primary" disabled={busy || !me.canSign} onClick={() => void issue()}>{busy ? "Signing…" : "Confirm and sign"}</button>
          </div>
          {!me.canSign && (
            <div className="warnbox stack">
              <span>{me.role === "demo" ? "The demo account cannot sign mandates." : "The owner key is not on this server (that is the safe setup). Sign it on your own machine:"}</span>
              {me.role !== "demo" && (
                <>
                  <pre className="json">{prettyMandate(draft.proposed)}</pre>
                  <code>{cli}</code>
                  <div className="row"><button className="btn small" onClick={() => void copy(prettyMandate(draft.proposed))}>Copy mandate.json</button><button className="btn small" onClick={() => void copy(cli)}>Copy command</button></div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {issued && (
        <section className="card" aria-label="Signed mandate">
          <h2>Signed</h2>
          <div className="ok">Mandate {issued.mandate.id} for <strong>{issued.mandate.agentId}</strong> is valid until {dateTime(issued.mandate.expiresAt)}. It is recorded in the audit log.</div>
          <p className="small ink2"><strong>This is the agent's credential and it is shown only once.</strong> Give it to the agent (<code>PAYLEASH_MANDATE</code> for stdio, or the <code>Authorization: Bearer</code> header over HTTP). PayLeash does not store it.</p>
          <div className="token-box mono" data-testid="token">{issued.token}</div>
          <div className="row"><button className="btn" onClick={async () => { await copy(issued.token); setCopied(true); }}>{copied ? "Copied" : "Copy the mandate"}</button></div>
        </section>
      )}

      <section className="card" aria-label="Current mandates">
        <h2>Mandates in force</h2>
        {info.loading && !info.data && <Spinner />}
        {info.data?.agents.length === 0 && <p className="small muted">None yet.</p>}
        <div className="grid cols-2">
          {info.data?.agents.map((a) => (
            <div key={a.agentId} className="card flat">
              <div className="row between"><strong>{a.agentId}</strong><span className="small muted">until {dateTime(a.expiresAt)}</span></div>
              <pre className="json">{prettyMandate(a.current)}</pre>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
