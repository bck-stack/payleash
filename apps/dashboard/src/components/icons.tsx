const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
export const IconOverview = () => (
  <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
export const IconInbox = () => (
  <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M4 13l2.5-8h11L20 13v6H4z" /><path d="M4 13h5l1 2h4l1-2h5" /></svg>
);
export const IconPolicy = () => (
  <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>
);
export const IconAudit = () => (
  <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>
);
export const IconBacktest = () => (
  <svg viewBox="0 0 24 24" {...p} aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 8v5l3 2" /></svg>
);
export const Logo = () => (
  <svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#0f6b5c" /><path d="M148 150h132c52 0 88 30 88 78s-36 78-88 78h-60v66h-72z" fill="none" stroke="#fff" strokeWidth="40" strokeLinejoin="round" /><circle cx="352" cy="360" r="26" fill="#fab219" /></svg>
);
