import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { useApp } from "../context";

const b64ToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** Turns on Web Push for this browser. Only shown to the owner, and only when the server has VAPID keys. */
export function PushButton() {
  const { me, refreshMe } = useApp();
  const [state, setState] = useState<"unknown" | "off" | "on" | "blocked" | "unsupported">("unknown");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setState("unsupported");
    if (Notification.permission === "denied") return setState("blocked");
    navigator.serviceWorker.getRegistration().then(async (r) => setState((await r?.pushManager.getSubscription()) ? "on" : "off"));
  }, []);

  if (me.role !== "owner" || !me.push.enabled || !me.push.publicKey || state === "unsupported") return null;

  const enable = async () => {
    setMsg(null);
    try {
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      if ((await Notification.requestPermission()) !== "granted") return setState("blocked");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(me.push.publicKey!) });
      await api("/api/push/subscribe", { body: { subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 60) } });
      setState("on");
      refreshMe();
      await api("/api/push/test", { method: "POST", body: {} });
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  const disable = async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api("/api/push/unsubscribe", { body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    setState("off");
    refreshMe();
  };

  return (
    <span className="row" style={{ gap: 6 }}>
      <button className="btn small" onClick={state === "on" ? disable : enable} disabled={state === "blocked"} title={state === "blocked" ? "Notifications are blocked in this browser" : undefined}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" /><path d="M10 20a2 2 0 0 0 4 0" /></svg> {state === "on" ? "Alerts on" : state === "blocked" ? "Alerts blocked" : "Get alerts"}
      </button>
      {msg && <span className="small" style={{ color: "var(--crit-text)" }}>{msg}</span>}
    </span>
  );
}
