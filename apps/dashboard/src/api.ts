export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

/** Fired when the server says the session is gone, so the app can show the login page. */
export const UNAUTH_EVENT = "payleash:unauthenticated";

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    credentials: "same-origin",
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; details?: unknown };
    if (res.status === 401 && !path.startsWith("/api/login") && path !== "/api/me") window.dispatchEvent(new Event(UNAUTH_EVENT));
    throw new ApiError(res.status, j.error ?? `Request failed (${res.status})`, Array.isArray(j.details) ? j.details.map(String) : undefined);
  }
  return json as T;
}

export const errorText = (e: unknown): string => (e instanceof ApiError ? [e.message, ...(e.details ?? [])].join(" ") : e instanceof Error ? e.message : String(e));
