import type { PayPalTransport } from "./rest-reader.js";

export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
const SANDBOX_HOSTS = new Set(["api-m.sandbox.paypal.com", "api.sandbox.paypal.com"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class LiveEndpointError extends Error {}

/**
 * Sandbox guard. Anything that is not a known PayPal sandbox host (or a local mock server) is treated as
 * live and refused unless `allowLive` is set (the `--i-know-this-is-live` flag).
 */
export function assertSandboxBaseUrl(baseUrl: string, opts: { allowLive?: boolean } = {}): "sandbox" | "local" | "live" {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new LiveEndpointError(`PAYPAL_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  if (SANDBOX_HOSTS.has(host)) return "sandbox";
  if (LOCAL_HOSTS.has(bracketed)) return "local";
  if (opts.allowLive) return "live";
  throw new LiveEndpointError(
    `Refusing to start: ${baseUrl} is not the PayPal sandbox. PayLeash is sandbox-only. ` +
      `If you really mean to talk to ${host}, pass --i-know-this-is-live.`,
  );
}

export interface PayPalHttpOptions {
  baseUrl?: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  allowLive?: boolean;
  now?: () => number;
}

export interface PayPalResponse {
  status: number;
  body: unknown;
}

/** Minimal authenticated PayPal REST client (client-credentials OAuth, cached token). */
export class PayPalHttp implements PayPalTransport {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token?: { value: string; expiresAtMs: number };
  private readonly now: () => number;

  constructor(private readonly opts: PayPalHttpOptions) {
    this.baseUrl = (opts.baseUrl ?? SANDBOX_BASE_URL).replace(/\/+$/, "");
    assertSandboxBaseUrl(this.baseUrl, { allowLive: opts.allowLive });
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs - 60_000 > this.now()) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal OAuth failed with status ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAtMs: this.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  async request(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<PayPalResponse> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body };
  }

  get(path: string): Promise<PayPalResponse> {
    return this.request("GET", path);
  }
}
