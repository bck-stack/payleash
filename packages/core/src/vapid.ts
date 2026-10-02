import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultKeyDir, isInsideGitRepo } from "./keys.js";

/**
 * VAPID keys identify this server to browser push services (Web Push). They live next to the signing keys,
 * outside the repository: `payleash vapid init` writes `vapid.json` into the key directory, or set
 * PAYLEASH_VAPID_PUBLIC / PAYLEASH_VAPID_PRIVATE / PAYLEASH_VAPID_SUBJECT (for hosts without a persistent disk).
 */
export interface VapidKeys {
  /** Uncompressed P-256 point, base64url. Goes to the browser. */
  publicKey: string;
  /** P-256 private scalar, base64url. Never leaves the server. */
  privateKey: string;
  /** `mailto:` or `https:` contact the push service may use. */
  subject: string;
}

const vapidPath = (dir: string) => join(dir, "vapid.json");

export function generateVapidKeys(subject: string): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  const publicKey = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  return { publicKey, privateKey: jwk.d, subject };
}

export function validSubject(s: string): boolean {
  return /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || /^https:\/\/[^\s/]+/.test(s);
}

export function initVapid(opts: { dir?: string; subject: string; force?: boolean; allowInRepo?: boolean }): { dir: string; file: string; keys: VapidKeys } {
  const dir = resolve(opts.dir ?? defaultKeyDir());
  if (!validSubject(opts.subject)) throw new Error('--subject must be "mailto:you@example.com" or an https:// URL');
  if (!opts.allowInRepo && isInsideGitRepo(dir)) throw new Error(`refusing to store keys inside a git repository (${dir}). Choose a directory outside the repo.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = vapidPath(dir);
  if (existsSync(file) && !opts.force) throw new Error(`${file} already exists (use --force to replace it; existing browser subscriptions stop working)`);
  const keys = generateVapidKeys(opts.subject);
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return { dir, file, keys };
}

/** From the environment first, then `vapid.json` in the key directory. Returns null when push is not set up. */
export function loadVapid(env: NodeJS.ProcessEnv = process.env): VapidKeys | null {
  const publicKey = env.PAYLEASH_VAPID_PUBLIC?.trim();
  const privateKey = env.PAYLEASH_VAPID_PRIVATE?.trim();
  if (publicKey && privateKey) return { publicKey, privateKey, subject: env.PAYLEASH_VAPID_SUBJECT?.trim() || "mailto:owner@example.com" };
  const file = vapidPath(defaultKeyDir(env));
  if (!existsSync(file)) return null;
  const j = JSON.parse(readFileSync(file, "utf8")) as Partial<VapidKeys>;
  if (!j.publicKey || !j.privateKey || !j.subject) throw new Error(`${file} is incomplete; run: payleash vapid init --force`);
  return { publicKey: j.publicKey, privateKey: j.privateKey, subject: j.subject };
}
