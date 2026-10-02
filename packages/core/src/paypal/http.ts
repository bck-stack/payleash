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

export interface TokenInfo {
  accessToken: string;
  /** Scopes PayPal attached to this token, one per entry. Permission changes in the developer dashboard show up here only on a NEW token. */
  scopes: string[];
  expiresInSeconds: number;
  appId?: string;
}

/** Minimal authenticated PayPal REST client (client-credentials OAuth, cached token). */
export class PayPalHttp implements PayPalTransport {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token?: { value: string; expiresAtMs: number; info: TokenInfo };
  private readonly now: () => number;

  constructor(private readonly opts: PayPalHttpOptions) {
    this.baseUrl = (opts.baseUrl ?? SANDBOX_BASE_URL).replace(/\/+$/, "");
    assertSandboxBaseUrl(this.baseUrl, { allowLive: opts.allowLive });
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private basicAuth(): string {
    return Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
  }

  async accessToken(): Promise<string> {
    return (await this.tokenInfo()).accessToken;
  }

  /** The current access token with the scopes PayPal granted it (fetched once, then cached until shortly before it expires). */
  async tokenInfo(): Promise<TokenInfo> {
    if (this.token && this.token.expiresAtMs - 60_000 > this.now()) return this.token.info;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${this.basicAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal OAuth failed with status ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number; scope?: string; app_id?: string };
    const info: TokenInfo = {
      accessToken: json.access_token,
      scopes: typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean).sort() : [],
      expiresInSeconds: json.expires_in,
      appId: json.app_id,
    };
    this.token = { value: json.access_token, expiresAtMs: this.now() + json.expires_in * 1000, info };
    return info;
  }

  /**
   * Asks PayPal to terminate an access token (`POST /v1/oauth2/token/terminate`) and forgets the local cache.
   * PayPal caches one access token per app for about 9 hours; permission (scope) changes made in the developer
   * dashboard only reach the app once that token is gone.
   */
  async terminateAccessToken(token?: string): Promise<{ status: number; ok: boolean; body: string }> {
    const target = token ?? (await this.accessToken());
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token/terminate`, {
      method: "POST",
      headers: { Authorization: `Basic ${this.basicAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: target, token_type_hint: "ACCESS_TOKEN" }).toString(),
    });
    this.token = undefined;
    return { status: res.status, ok: res.ok, body: (await res.text()).slice(0, 300) };
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

export interface RefreshTokenResult {
  terminated: { ok: boolean; status: number; body: string };
  before: TokenInfo;
  after: TokenInfo;
  /** False means PayPal handed back the same token: the terminate call did not take effect. */
  replaced: boolean;
  /** Scopes the new token has that the old one did not (and the other way round). */
  scopesAdded: string[];
  scopesRemoved: string[];
}

/** Terminates the cached sandbox access token and fetches a fresh one, so changed app permissions apply. */
export async function refreshAccessToken(http: PayPalHttp): Promise<RefreshTokenResult> {
  const before = await http.tokenInfo();
  const terminated = await http.terminateAccessToken(before.accessToken);
  const after = await http.tokenInfo();
  return {
    terminated,
    before,
    after,
    replaced: after.accessToken !== before.accessToken,
    scopesAdded: after.scopes.filter((s) => !before.scopes.includes(s)),
    scopesRemoved: before.scopes.filter((s) => !after.scopes.includes(s)),
  };
}
