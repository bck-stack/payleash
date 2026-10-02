import type { ReactNode } from "react";
import { DECISION_LABEL } from "../format";

export function DecisionBadge({ decision }: { decision: string }) {
  const d = DECISION_LABEL[decision] ?? { label: decision, icon: "•", tone: "muted" as const };
  return (
    <span className={`badge ${d.tone}`}>
      <span aria-hidden="true">{d.icon}</span>
      {d.label}
    </span>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="row muted small">
      <span className="spin" aria-hidden="true" /> {label}…
    </span>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  return message ? (
    <div className="error" role="alert">
      {message}
    </div>
  ) : null;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p className="small">{children}</p>}
    </div>
  );
}

export function Stat({ value, label, detail, tone }: { value: ReactNode; label: string; detail?: ReactNode; tone?: "good" | "warn" | "crit" }) {
  return (
    <div className="card stat">
      <div className="l">{label}</div>
      <div className="v" style={tone ? { color: `var(--${tone}-text)` } : undefined}>
        {value}
      </div>
      {detail && <div className="d ink2">{detail}</div>}
    </div>
  );
}

export function copy(text: string): Promise<void> {
  return navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("clipboard unavailable"));
}
