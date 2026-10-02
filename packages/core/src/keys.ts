import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Two Ed25519 key pairs:
 *  - `owner`: signs operation mandates. Keep the private half off the proxy host.
 *  - `stepup`: used by the proxy to mint single-use step-up mandates when the owner approves a held call.
 */
export type KeyRole = "owner" | "stepup";

export function defaultKeyDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PAYLEASH_KEY_DIR) return resolve(env.PAYLEASH_KEY_DIR);
  const base = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(homedir(), ".config");
  return join(base, "payleash");
}

/** True when `dir` (or its nearest existing ancestor) sits inside a git work tree. */
export function isInsideGitRepo(dir: string): boolean {
  let cur = resolve(dir);
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
  cur = realpathSync(cur);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return true;
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

const privatePath = (dir: string, role: KeyRole) => join(dir, `${role}.key.pem`);
const publicPath = (dir: string, role: KeyRole) => join(dir, `${role}.pub.pem`);

export interface InitKeysOptions {
  dir?: string;
  force?: boolean;
  allowInRepo?: boolean;
}

export function initKeys(opts: InitKeysOptions = {}): { dir: string; files: string[] } {
  const dir = resolve(opts.dir ?? defaultKeyDir());
  if (!opts.allowInRepo && isInsideGitRepo(dir)) {
    throw new Error(`refusing to store keys inside a git repository (${dir}). Choose a directory outside the repo.`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  for (const role of ["owner", "stepup"] as const) {
    const priv = privatePath(dir, role);
    const pub = publicPath(dir, role);
    if (!opts.force && (existsSync(priv) || existsSync(pub))) {
      throw new Error(`${priv} already exists (use --force to overwrite; existing mandates signed with it stop verifying)`);
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
    files.push(priv, pub);
  }
  return { dir, files };
}

export function loadPrivateKey(dir: string, role: KeyRole): KeyObject {
  const p = privatePath(dir, role);
  if (!existsSync(p)) throw new Error(`missing ${p}. Run: payleash keys init`);
  return createPrivateKey(readFileSync(p));
}

export function loadPublicKey(dir: string, role: KeyRole): KeyObject {
  const pub = publicPath(dir, role);
  if (existsSync(pub)) return createPublicKey(readFileSync(pub));
  // Fall back to deriving it from the private key if only that is present.
  return createPublicKey(loadPrivateKey(dir, role));
}
