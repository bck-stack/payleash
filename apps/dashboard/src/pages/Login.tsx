import { useState } from "react";
import { api, errorText } from "../api";
import { ErrorBox } from "../components/ui";
import { Logo } from "../components/icons";
import type { Me } from "../types";

export function Login({ me, onDone }: { me: Me; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (t: string) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/login", { body: { token: t } });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={(e) => { e.preventDefault(); void submit(token); }}>
        <div className="row"><span className="brand"><Logo /> PayLeash</span></div>
        <h1>Sign in</h1>
        <p className="ink2 small">The trust layer for AI agents in your PayPal back office. Use your owner token (<code>PAYLEASH_OWNER_TOKEN</code>).</p>
        {me.demo && (
          <p className="small ink2" role="note">
            This is the hosted demo. It runs on free hosting that sleeps when idle, so the first load can take about 30 seconds. PayPal is a recording and the data resets every night{me.demoReset?.next ? " (03:00 UTC)" : ""}.
          </p>
        )}
        {!me.loginEnabled && <div className="warnbox">Login is disabled on this server: set <code>PAYLEASH_OWNER_TOKEN</code>.</div>}
        <label>
          Owner token
          <input type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
        </label>
        <ErrorBox message={error} />
        <button className="btn primary big" disabled={busy || !token || !me.loginEnabled}>{busy ? "Signing in…" : "Sign in"}</button>
        {me.demoLoginAvailable && (
          <div className="stack">
            <hr style={{ width: "100%", border: 0, borderTop: "1px solid var(--line)" }} />
            <p className="small ink2"><strong>Judges and visitors:</strong> the demo account is read-only. It sees everything and can approve or deny the seeded demo calls, which run against recorded PayPal data.</p>
            {me.demoPasscode ? (
              <button type="button" className="btn big" disabled={busy} onClick={() => void submit(me.demoPasscode!)}>Enter the read-only demo</button>
            ) : (
              <p className="small muted">Enter the demo passcode from the README in the field above.</p>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
