export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function timeLeft(iso: string, now = Date.now()): string {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  if (s <= 0) return "expired";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min left`;
  return `${Math.round(m / 60)} h left`;
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const dateTime = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };
export function money(amount: number | string, currency = "USD"): string {
  const n = Number(amount);
  const text = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return SYMBOL[currency] ? `${SYMBOL[currency]}${text}` : `${text} ${currency}`;
}

export const toolName = (t: string) => t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Which decisions the audit log can hold, with the words and symbol people see (never colour alone). */
export const DECISION_LABEL: Record<string, { label: string; icon: string; tone: "good" | "warn" | "crit" | "info" | "muted" }> = {
  allow: { label: "Ran", icon: "✓", tone: "good" },
  executed: { label: "Executed", icon: "✓", tone: "good" },
  hold: { label: "Held", icon: "‖", tone: "warn" },
  deny: { label: "Denied", icon: "✕", tone: "crit" },
  execution_failed: { label: "PayPal refused", icon: "!", tone: "crit" },
  approve: { label: "Approved", icon: "✔", tone: "info" },
  reject: { label: "Rejected", icon: "✘", tone: "info" },
  freeze: { label: "Frozen", icon: "❄", tone: "crit" },
  unfreeze: { label: "Unfrozen", icon: "▶", tone: "info" },
  mandate_issued: { label: "Mandate signed", icon: "✎", tone: "info" },
};
