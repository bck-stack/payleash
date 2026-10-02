import { readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import {
  AuditLog,
  FixturePayPalReader,
  Guard,
  PayPalHttp,
  RegistryBook,
  RestPayPalReader,
  SANDBOX_BASE_URL,
  SqlitePolicyStore,
  SqliteReplayGuard,
  assertSandboxBaseUrl,
  buildDemoFixtures,
  defaultKeyDir,
  explainerFromEnv,
  loadPrivateKey,
  loadPublicKey,
  openDb,
  resolveDbPath,
  type Db,
  type PayPalReader,
} from "@payleash/core";
import { ApprovalStore } from "./approvals.js";
import { ProxyApp } from "./app.js";
import type { ProxyOptions } from "./config.js";
import { FixtureExecutor } from "./fixture-executor.js";
import { ToolkitExecutor, type ToolExecutor } from "./executor.js";
import { loadToolkitTools, type ToolkitTool } from "./toolkit.js";

export interface ProxyOverrides {
  db?: Db;
  executor?: ToolExecutor;
  reader?: PayPalReader;
  keys?: { ownerPublic: KeyObject; stepUpPrivate: KeyObject; stepUpPublic: KeyObject };
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ProxyRuntime {
  app: ProxyApp;
  tools: ToolkitTool[];
  db: Db;
  mode: "sandbox" | "fixtures";
  baseUrl: string;
  /** Present in fixtures mode so callers can inspect what "PayPal" received. */
  fixtureExecutor?: FixtureExecutor;
  ownerToken?: string;
  close(): void;
}

export const MIN_OWNER_TOKEN_LENGTH = 16;

/** Wires keys, database, PayPal access, the guard and the app. Throws with a clear message on bad configuration. */
export function buildProxy(opts: ProxyOptions, env: NodeJS.ProcessEnv = process.env, o: ProxyOverrides = {}): ProxyRuntime {
  const log = o.log ?? ((line: string) => process.stderr.write(`[payleash] ${line}\n`));

  // Sandbox guard: refuse to start against anything that is not the PayPal sandbox.
  const baseUrl = env.PAYPAL_BASE_URL?.trim() || SANDBOX_BASE_URL;
  const kind = assertSandboxBaseUrl(baseUrl, { allowLive: opts.allowLive });
  if (kind === "live") log("WARNING: running against a NON-SANDBOX PayPal endpoint because --i-know-this-is-live was given.");

  const ownerToken = env.PAYLEASH_OWNER_TOKEN?.trim() || undefined;
  if (ownerToken && ownerToken.length < MIN_OWNER_TOKEN_LENGTH) {
    throw new Error(`PAYLEASH_OWNER_TOKEN must be at least ${MIN_OWNER_TOKEN_LENGTH} characters (try: openssl rand -hex 24)`);
  }

  const keys =
    o.keys ??
    (() => {
      const dir = defaultKeyDir(env);
      try {
        return { ownerPublic: loadPublicKey(dir, "owner"), stepUpPrivate: loadPrivateKey(dir, "stepup"), stepUpPublic: loadPublicKey(dir, "stepup") };
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)} (looked in ${dir}; set PAYLEASH_KEY_DIR)`);
      }
    })();

  const db = o.db ?? openDb(resolveDbPath(env));
  const policy = new SqlitePolicyStore(db);
  const audit = new AuditLog(db);
  const registries = new RegistryBook();

  let reader: PayPalReader;
  let executor: ToolExecutor;
  let fixtureExecutor: FixtureExecutor | undefined;
  if (o.executor || o.reader) {
    if (!o.executor || !o.reader) throw new Error("override both `executor` and `reader`, or neither");
    executor = o.executor;
    reader = o.reader;
    if (executor instanceof FixtureExecutor) fixtureExecutor = executor;
  } else if (opts.fixtures) {
    const responses = buildDemoFixtures(o.now?.() ?? new Date());
    reader = new FixturePayPalReader(responses);
    executor = fixtureExecutor = new FixtureExecutor(responses);
    log("FIXTURE MODE: PayPal is simulated with recorded responses. No sandbox calls are made.");
  } else {
    const clientId = env.PAYPAL_CLIENT_ID?.trim();
    const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox REST app credentials) are required. For a demo without credentials, pass --fixtures.");
    }
    if (kind === "local") throw new Error("PAYPAL_BASE_URL points at a local server, but the PayPal Agent Toolkit only talks to PayPal's own hosts. Use --fixtures, or the sandbox URL.");
    const http = new PayPalHttp({ baseUrl, clientId, clientSecret, allowLive: opts.allowLive });
    reader = new RestPayPalReader(http);
    executor = new ToolkitExecutor(http, kind === "sandbox");
  }

  const guard = new Guard({
    policy,
    audit,
    replay: new SqliteReplayGuard(db),
    reader,
    registries,
    ownerPublicKey: keys.ownerPublic,
    stepUpPublicKey: keys.stepUpPublic,
    explainer: explainerFromEnv(env, (e) => log(`explanation LLM failed, using template: ${e instanceof Error ? e.message : String(e)}`)),
    now: o.now,
  });

  const approvals = new ApprovalStore(db, o.now ? () => o.now!().getTime() : undefined);
  const app = new ProxyApp({
    guard,
    policy,
    audit,
    approvals,
    executor,
    registries,
    reader,
    ownerPublicKey: keys.ownerPublic,
    stepUpPrivateKey: keys.stepUpPrivate,
    approvalTtlMs: env.PAYLEASH_APPROVAL_TTL_MIN ? Number(env.PAYLEASH_APPROVAL_TTL_MIN) * 60_000 : undefined,
    now: o.now,
    log,
  });

  const { tools, unclassified } = loadToolkitTools();
  if (unclassified.length) log(`WARNING: withholding unclassified toolkit tools (add them to classification.ts): ${unclassified.join(", ")}`);

  return {
    app,
    tools,
    db,
    mode: fixtureExecutor ? "fixtures" : "sandbox",
    baseUrl,
    fixtureExecutor,
    ownerToken,
    close: () => {
      if (!o.db) db.close();
    },
  };
}

/** Mandate for the stdio transport: PAYLEASH_MANDATE, or the file named by PAYLEASH_MANDATE_FILE. */
export function stdioMandateToken(env: NodeJS.ProcessEnv): string {
  const token = env.PAYLEASH_MANDATE?.trim() || (env.PAYLEASH_MANDATE_FILE ? readFileSync(env.PAYLEASH_MANDATE_FILE, "utf8").trim() : "");
  if (!token) throw new Error("stdio transport needs the agent's mandate: set PAYLEASH_MANDATE (or PAYLEASH_MANDATE_FILE). Issue one with `payleash mandate issue`.");
  return token;
}
