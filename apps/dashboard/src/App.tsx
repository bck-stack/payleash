import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { UNAUTH_EVENT, api } from "./api";
import { PushButton } from "./components/PushButton";
import { IconAudit, IconBacktest, IconInbox, IconOverview, IconPolicy, Logo } from "./components/icons";
import { Spinner } from "./components/ui";
import { AppContext } from "./context";
import { useInterval, useLoad, usePersisted } from "./hooks";
import type { Me } from "./types";
import { Approvals } from "./pages/Approvals";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Policies } from "./pages/Policies";

// The two pages that carry AG Grid are loaded on demand, so the first screen stays small.
const Audit = lazy(() => import("./pages/Audit").then((m) => ({ default: m.Audit })));
const Backtest = lazy(() => import("./pages/Backtest").then((m) => ({ default: m.Backtest })));

type Theme = "auto" | "light" | "dark";

function useTheme() {
  const [theme, setTheme] = usePersisted("payleash-theme", "auto");
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    const dark = theme === "dark" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.body.dataset.agThemeMode = dark ? "dark" : "light";
  }, [theme]);
  return [theme as Theme, (t: Theme) => setTheme(t)] as const;
}

export function App() {
  const me = useLoad<Me>(() => api<Me>("/api/me"), []);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    const on = () => me.reload();
    window.addEventListener(UNAUTH_EVENT, on);
    return () => window.removeEventListener(UNAUTH_EVENT, on);
  }, [me]);

  if (me.loading && !me.data) return <div className="login"><Spinner /></div>;
  if (!me.data) return <div className="login"><div className="card"><div className="error">Cannot reach the PayLeash server. {me.error}</div><button className="btn" onClick={me.reload}>Retry</button></div></div>;
  if (!me.data.authenticated) return <Login me={me.data} onDone={me.reload} />;
  return <Shell me={me.data} refreshMe={me.reload} theme={theme} setTheme={setTheme} />;
}

function Shell({ me, refreshMe, theme, setTheme }: { me: Me; refreshMe: () => void; theme: Theme; setTheme: (t: Theme) => void }) {
  const [pending, setPending] = useState(0);
  const [frozen, setFrozen] = useState(false);
  const refreshCount = useCallback(() => {
    api<{ pendingTotal: number; frozen: { global: unknown } }>(`/api/overview?tz=${new Date().getTimezoneOffset()}`)
      .then((o) => {
        setPending(o.pendingTotal);
        setFrozen(!!o.frozen.global);
      })
      .catch(() => {});
  }, []);
  useEffect(refreshCount, [refreshCount]);
  useInterval(refreshCount, 10_000);

  const logout = async () => {
    await api("/api/logout", { method: "POST", body: {} }).catch(() => {});
    refreshMe();
  };
  const next: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };

  return (
    <AppContext.Provider value={{ me, refreshMe, pending, setPending }}>
      <div className="shell">
        <header className="topbar">
          <NavLink to="/" className="brand"><Logo /> PayLeash</NavLink>
          {frozen && <span className="badge crit"><span aria-hidden="true">❄</span> All agents frozen</span>}
          {me.mode === "fixtures" && <span className="badge info" title="PayPal is simulated with recorded data. Nothing is sent to PayPal.">Demo data</span>}
          <span className="spacer" />
          <PushButton />
          <button className="btn small" onClick={() => setTheme(next[theme])} aria-label={`Theme: ${theme}. Change theme`} title={`Theme: ${theme}`}>
            <span aria-hidden="true">{theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}</span>
          </button>
          <span className="badge muted small role-badge">{me.role === "demo" ? "Demo (read-only)" : "Owner"}</span>
          <button className="btn small" onClick={logout}>Sign out</button>
        </header>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end><IconOverview />Overview</NavLink>
          <NavLink to="/approvals"><IconInbox />Approvals{pending > 0 && <span className="dot" aria-label={`${pending} waiting`}>{pending}</span>}</NavLink>
          <NavLink to="/policies"><IconPolicy />Policies</NavLink>
          <NavLink to="/audit"><IconAudit />Audit</NavLink>
          <NavLink to="/backtest"><IconBacktest />Backtest</NavLink>
        </nav>
        <main className="main">
          {me.role === "demo" && (
            <div className="banner info small" role="note">
              <span><strong>Demo account.</strong> You can look at everything, and approve or deny the seeded demo calls. PayPal here is a recording: nothing real is sent.</span>
            </div>
          )}
          <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<Overview onChange={refreshCount} />} />
            <Route path="/approvals" element={<Approvals onChange={refreshCount} />} />
            <Route path="/policies" element={<Policies />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/backtest" element={<Backtest />} />
            <Route path="*" element={<Overview onChange={refreshCount} />} />
          </Routes>
          </Suspense>
        </main>
      </div>
    </AppContext.Provider>
  );
}
