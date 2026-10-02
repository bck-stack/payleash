import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Grid, type GridApi, type GridReadyEvent } from "../components/Grid";
import { toast } from "../components/feedback";
import { DecisionBadge, ErrorBox, Spinner } from "../components/ui";
import { DECISION_LABEL, dateTime, toolName } from "../format";
import { useLoad } from "../hooks";
import type { AuditRow, VerifyResult } from "../types";

const Badge = (p: ICellRendererParams<AuditRow>) => (p.value ? <span className="badge-cell"><DecisionBadge decision={p.value} /></span> : null);

export function Audit() {
  const audit = useLoad<{ entries: AuditRow[]; head: { seq: number; hash: string } }>(() => api("/api/audit?limit=2000"), [], 15000);
  const verify = useLoad<VerifyResult>(() => api("/api/audit/verify"), [], 30000);
  const apiRef = useRef<GridApi<AuditRow> | null>(null);
  const [quick, setQuick] = useState("");
  const [selected, setSelected] = useState<AuditRow | null>(null);

  const cols = useMemo<ColDef<AuditRow>[]>(
    () => [
      { field: "seq", headerName: "#", width: 90, filter: "agNumberColumnFilter", sort: "desc" },
      { field: "ts", headerName: "Time", width: 170, valueFormatter: (p) => (p.value ? dateTime(p.value) : ""), filter: "agTextColumnFilter", comparator: (a, b) => Date.parse(a) - Date.parse(b) },
      { field: "agent", width: 140 },
      { field: "tool", width: 190, valueFormatter: (p) => toolName(p.value ?? "") },
      { field: "decision", width: 160, cellRenderer: Badge, filterValueGetter: (p) => DECISION_LABEL[p.data?.decision ?? ""]?.label ?? p.data?.decision },
      { field: "summary", headerName: "What", flex: 1, minWidth: 220 },
      { headerName: "Reasons", minWidth: 220, flex: 1, valueGetter: (p) => p.data?.reasonsGrouped.map((r) => (r.count > 1 ? `${r.title} ×${r.count}` : r.title)).join(", ") ?? "" },
      { field: "paypalResultId", headerName: "PayPal id", width: 190 },
      { field: "hash", headerName: "Hash", width: 130, valueFormatter: (p) => (p.value ? `${String(p.value).slice(0, 12)}…` : "") },
    ],
    [],
  );

  const onReady = useCallback((e: GridReadyEvent<AuditRow>) => {
    apiRef.current = e.api;
  }, []);

  const v = verify.data;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p>Every decision and every execution, chained by SHA-256 so that an edit, a deletion or an insertion is detected.</p>
        </div>
        <div className="row" aria-live="polite">
          {verify.loading && !v ? <Spinner label="Verifying" /> : v ? (
            <span className={`badge ${v.ok ? "good" : "crit"}`} style={{ fontSize: "0.95rem", padding: "6px 14px" }} title={v.ok ? `Head #${v.headSeq} ${v.headHash}` : v.problems.map((p) => `#${p.seq} ${p.message}`).join("\n")}>
              <span aria-hidden="true">{v.ok ? "✓" : "✗"}</span> {v.ok ? `Chain verified · ${v.entries} entries` : "TAMPERED"}
            </span>
          ) : null}
          <button className="btn small" onClick={() => { verify.reload(); audit.reload(); }}>Verify again</button>
        </div>
      </div>
      {v && !v.ok && (
        <div className="banner crit" role="alert">
          <span><strong>The audit log has been modified.</strong> {v.problems.length} problem{v.problems.length === 1 ? "" : "s"}: {v.problems.slice(0, 3).map((p) => `#${p.seq} ${p.problem}`).join(", ")}. Treat every entry after the first problem as untrusted.</span>
        </div>
      )}
      <ErrorBox message={audit.error ?? verify.error} onRetry={() => { audit.reload(); verify.reload(); }} />

      <section className="card" aria-label="Audit entries">
        <div className="row">
          <input type="search" placeholder="Search every column…" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Search the audit log" style={{ maxWidth: 360 }} />
          <span className="spacer" />
          <span className="small muted">{audit.data?.entries.length ?? 0} entries</span>
          <button className="btn small" onClick={() => { apiRef.current?.exportDataAsCsv({ fileName: `payleash-audit-${new Date().toISOString().slice(0, 10)}.csv`, columnKeys: ["seq", "ts", "agent", "tool", "decision", "summary", "paypalResultId", "hash"] }); toast.info("Exported what the filters show as CSV."); }}>Export CSV</button>
        </div>
        <Grid<AuditRow>
          rowData={audit.data?.entries ?? []}
          columnDefs={cols}
          quickFilterText={quick}
          onGridReady={onReady}
          getRowId={(p) => String(p.data.seq)}
          rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => setSelected(e.data ?? null)}
          pagination
          paginationPageSize={50}
          paginationPageSizeSelector={[25, 50, 100, 500]}
          loading={audit.loading && !audit.data}
          overlayNoRowsTemplate="No audit entries yet. Decisions appear here as agents call PayPal through PayLeash."
        />
        <p className="small muted">Tap a row for details. Sort and filter on any column; Export CSV downloads what you see.</p>
      </section>

      {selected && (
        <section className="card" aria-label={`Entry ${selected.seq}`}>
          <div className="row between">
            <h2>Entry #{selected.seq}</h2>
            <button className="btn small" onClick={() => setSelected(null)}>Close</button>
          </div>
          <div className="detail">
            <div className="row"><DecisionBadge decision={selected.decision} /><span>{selected.agent} · {toolName(selected.tool)}</span><span className="muted small">{dateTime(selected.ts)}</span></div>
            <div>
              <h3>Reasons (as people see them)</h3>
              {selected.reasonsGrouped.length === 0 ? <p className="small muted">None.</p> : (
                <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {selected.reasonsGrouped.map((r) => <li key={r.code}><strong>{r.title}</strong>{r.count > 1 ? ` ×${r.count}` : ""}: {r.details.join(" | ")}</li>)}
                </ul>
              )}
            </div>
            <div><h3>Raw reasons (the audit keeps every one)</h3><pre className="json" tabIndex={0}>{JSON.stringify(selected.reasons, null, 2)}</pre></div>
            <div><h3>Arguments</h3><pre className="json" tabIndex={0}>{JSON.stringify(selected.args, null, 2)}</pre></div>
            <dl className="facts">
              <dt>Mandate</dt><dd className="mono">{selected.mandateId ?? "none"}</dd>
              <dt>PayPal id</dt><dd className="mono">{selected.paypalResultId ?? "none"}</dd>
              <dt>Previous hash</dt><dd className="mono">{selected.prevHash}</dd>
              <dt>Hash</dt><dd className="mono">{selected.hash}</dd>
            </dl>
          </div>
        </section>
      )}
    </>
  );
}
