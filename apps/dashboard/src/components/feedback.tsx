import { useEffect, useRef, useState } from "react";

type Kind = "success" | "error" | "info";
interface ToastItem {
  id: number;
  kind: Kind;
  message: string;
}
export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  /** Styles the confirm button as a dangerous action. */
  danger?: boolean;
}

// Toasts and confirmations are reachable from anywhere (pages, hooks, the api helper) without a provider:
// they travel as events to the one <FeedbackHost /> mounted in the app shell.
const TOAST = "payleash:toast";
const CONFIRM = "payleash:confirm";

const emit = (kind: Kind, message: string) => window.dispatchEvent(new CustomEvent(TOAST, { detail: { kind, message } }));
export const toast = {
  success: (message: string) => emit("success", message),
  error: (message: string) => emit("error", message),
  info: (message: string) => emit("info", message),
};

/** An accessible modal question. Resolves true on confirm, false on cancel / Escape. Falls back to `window.confirm` if no host is mounted. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let handled = false;
    window.dispatchEvent(new CustomEvent(CONFIRM, { detail: { opts, resolve: (v: boolean) => { handled = true; resolve(v); } } }));
    queueMicrotask(() => {
      if (!handled && !document.querySelector("dialog.confirm")) resolve(window.confirm(`${opts.title}\n\n${opts.body}`));
    });
  });
}

let nextId = 1;

export function FeedbackHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [ask, setAsk] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const onToast = (e: Event) => {
      const { kind, message } = (e as CustomEvent<{ kind: Kind; message: string }>).detail;
      const id = nextId++;
      setItems((cur) => [...cur.slice(-3), { id, kind, message }]);
      setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), kind === "error" ? 9000 : 5000);
    };
    const onConfirm = (e: Event) => setAsk((e as CustomEvent<{ opts: ConfirmOptions; resolve: (v: boolean) => void }>).detail);
    window.addEventListener(TOAST, onToast);
    window.addEventListener(CONFIRM, onConfirm);
    return () => {
      window.removeEventListener(TOAST, onToast);
      window.removeEventListener(CONFIRM, onConfirm);
    };
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (ask && d && !d.open) d.showModal();
  }, [ask]);

  const close = (v: boolean) => {
    ask?.resolve(v);
    dialog.current?.close();
    setAsk(null);
  };

  return (
    <>
      <div className="toasts" role="region" aria-label="Notifications">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
            <span aria-hidden="true">{t.kind === "error" ? "✕" : t.kind === "success" ? "✓" : "i"}</span>
            <span className="msg">{t.message}</span>
            <button className="toast-x" aria-label="Dismiss" onClick={() => setItems((cur) => cur.filter((x) => x.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
      {ask && (
        <dialog ref={dialog} className="confirm" aria-labelledby="confirm-title" aria-describedby="confirm-body" onCancel={(e) => { e.preventDefault(); close(false); }}>
          <h2 id="confirm-title">{ask.opts.title}</h2>
          <p id="confirm-body" className="ink2">{ask.opts.body}</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" autoFocus onClick={() => close(false)}>Cancel</button>
            <button className={`btn ${ask.opts.danger ? "danger" : "primary"}`} onClick={() => close(true)}>{ask.opts.confirmLabel}</button>
          </div>
        </dialog>
      )}
    </>
  );
}
