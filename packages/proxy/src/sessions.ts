import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type Role = "owner" | "demo";

export const SESSION_COOKIE = "payleash_session";
const OWNER_TTL_MS = 7 * 24 * 3600_000;
const DEMO_TTL_MS = 24 * 3600_000;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * Signed, expiring session cookies for the dashboard. The cookie holds only a role and an expiry, never the
 * owner token. The signing key is derived from the owner token, so rotating the token signs everyone out.
 */
export class SessionManager {
  private readonly key: Buffer;

  constructor(ownerToken: string, private readonly now: () => number = Date.now) {
    this.key = createHash("sha256").update(`payleash-session-v1:${ownerToken}`).digest();
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }

  issue(role: Role): { value: string; maxAgeSeconds: number } {
    const ttl = role === "owner" ? OWNER_TTL_MS : DEMO_TTL_MS;
    const payload = b64(JSON.stringify({ r: role, exp: this.now() + ttl, n: b64(randomBytes(9)) }));
    return { value: `${payload}.${this.sign(payload)}`, maxAgeSeconds: Math.floor(ttl / 1000) };
  }

  verify(value: string | undefined): Role | null {
    if (!value) return null;
    const [payload, sig, extra] = value.split(".");
    if (!payload || !sig || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { r?: string; exp?: number };
      if ((p.r !== "owner" && p.r !== "demo") || typeof p.exp !== "number" || p.exp <= this.now()) return null;
      return p.r;
    } catch {
      return null;
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function cookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
export const clearCookieHeader = (secure: boolean) => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;

/** Failed-login throttle: `limit` failures per `windowMs` per key, then 429 until the window passes. */
export class LoginThrottle {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit = 8,
    private readonly windowMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}
  blocked(key: string): boolean {
    const h = this.hits.get(key);
    if (!h) return false;
    if (h.resetAt <= this.now()) {
      this.hits.delete(key);
      return false;
    }
    return h.count >= this.limit;
  }
  fail(key: string): void {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= this.now()) this.hits.set(key, { count: 1, resetAt: this.now() + this.windowMs });
    else h.count++;
    if (this.hits.size > 5000) this.hits.clear();
  }
  ok(key: string): void {
    this.hits.delete(key);
  }
}
