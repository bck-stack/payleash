import { readFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import {
  AuditLog,
  FixturePayPalReader,
  Guard,
  MandateRegistry,
  PayPalHttp,
  RegistryBook,
  RestPayPalReader,
  SANDBOX_BASE_URL,
  SqlitePolicyStore,
  SqliteReplayGuard,
  assertSandboxBaseUrl,
  buildDemoFixtures,
  chatClientFromEnv,
  defaultKeyDir,
  explainerFromEnv,
  loadPrivateKey,
  loadPublicKey,
  loadVapid,
  openDb,
  resolveDbPath,
  type ChatClient,
  type Db,
  type PayPalReader,
} from "@payleash/core";
import { ApprovalStore } from "./approvals.js";
import { ProxyApp } from "./app.js";
import type { ProxyOptions } from "./config.js";
import { FixtureExecutor } from "./fixture-executor.js";
import { ToolkitExecutor, type ToolExecutor } from "./executor.js";
import { loadToolkitTools, type ToolkitTool } from "./toolkit.js";
import { NATIVE_TOOLS } from "./native-tools.js";
import { Notifier, emailConfigFromEnv } from "./notify.js";
import { SessionManager } from "./sessions.js";
import { seedDemo } from "./demo.js";

export interface ProxyOverrides {
  db?: Db;
  executor?: ToolExecutor;
  reader?: PayPalReader;
  keys?: { ownerPublic: KeyObject; stepUpPrivate: KeyObject; stepUpPublic: KeyObject; ownerPrivate?: KeyObject };
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
  /** Read-only demo login (public by design). Only honoured in fixtures mode. */
  demoToken?: string;
  audit: AuditLog;
  policy: SqlitePolicyStore;
  approvals: ApprovalStore;
  mandates: MandateRegistry;
  registries: RegistryBook;
  /** Signs mandates from the dashboard. Absent when the owner key is not on this host (then the dashboard shows the CLI command instead). */
  ownerPrivateKey?: KeyObject;
  /** OpenAI-compatible model for plain-language policies; null when none is configured. */
  chat: ChatClient | null;
  chatProvider?: "cloudflare" | "custom";
  notifier: Notifier;
  sessions?: SessionManager;
  /** Sandbox access to PayPal (live backtest history). Absent in fixtures mode. */
  paypalHttp?: PayPalHttp;
  publicUrl?: string;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  /** Only in `--demo`: rebuild the seeded scenario (fixtures, budgets, held calls). */
  demo?: { reseed(o?: { activity?: boolean }): Promise<void> };
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

  const demo = !!opts.demo;
  const demoToken = demo ? env.PAYLEASH_DEMO_TOKEN?.trim() || undefined : undefined;
  if (demoToken && demoToken.length < 8) throw new Error("PAYLEASH_DEMO_TOKEN must be at least 8 characters");
  if (demoToken && demoToken === ownerToken) throw new Error("PAYLEASH_DEMO_TOKEN must differ from PAYLEASH_OWNER_TOKEN");

  const keys =
    o.keys ??
    (demo
      ? (() => {
          // A demo has no key directory: throw-away keys, so nothing here can ever sign a real agent's mandate.
          const owner = generateKeyPairSync("ed25519");
          const stepup = generateKeyPairSync("ed25519");
          return { ownerPublic: owner.publicKey, ownerPrivate: owner.privateKey, stepUpPrivate: stepup.privateKey, stepUpPublic: stepup.publicKey };
        })()
      : (() => {
          const dir = defaultKeyDir(env);
          try {
            let ownerPrivate: KeyObject | undefined;
            try {
              ownerPrivate = loadPrivateKey(dir, "owner");
            } catch {
              ownerPrivate = undefined; // the owner key may live on another machine: the dashboard then shows the CLI command
            }
            return { ownerPublic: loadPublicKey(dir, "owner"), ownerPrivate, stepUpPrivate: loadPrivateKey(dir, "stepup"), stepUpPublic: loadPublicKey(dir, "stepup") };
          } catch (e) {
            throw new Error(`${e instanceof Error ? e.message : String(e)} (looked in ${dir}; set PAYLEASH_KEY_DIR)`);
          }
        })());

  const db = o.db ?? openDb(demo && !env.PAYLEASH_DB_PATH ? ":memory:" : resolveDbPath(env));
  const policy = new SqlitePolicyStore(db);
  const audit = new AuditLog(db);
  const registries = new RegistryBook();
  const mandates = new MandateRegistry(db);
  const now = o.now ?? (() => new Date());

  let reader: PayPalReader;
  let paypalHttp: PayPalHttp | undefined;
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
    paypalHttp = http;
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
    mandates,
    explainer: explainerFromEnv(env, (e) => log(`explanation LLM failed, using template: ${e instanceof Error ? e.message : String(e)}`)),
    now: o.now,
  });

  const approvals = new ApprovalStore(db, o.now ? () => o.now!().getTime() : undefined);
  const publicUrl = env.PAYLEASH_PUBLIC_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim() || undefined;
  let vapid = null;
  try {
    vapid = loadVapid(env);
  } catch (e) {
    log(`Web Push disabled: ${e instanceof Error ? e.message : String(e)}`);
  }
  const notifier = new Notifier({ db, vapid, publicUrl, email: emailConfigFromEnv(env), log });
  const late: { rt?: ProxyRuntime } = {};
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
    // Late-bound so a replaced `rt.notifier` (tests, hot config) is the one that is told.
    onHold: ({ owner }) => void late.rt?.notifier.notifyHeld(owner),
  });

  const { tools: toolkitTools, unclassified } = loadToolkitTools();
  const tools = [...toolkitTools, ...NATIVE_TOOLS];
  if (unclassified.length) log(`WARNING: withholding unclassified toolkit tools (add them to classification.ts): ${unclassified.join(", ")}`);

  const rt: ProxyRuntime = {
    app,
    tools,
    db,
    mode: fixtureExecutor ? "fixtures" : "sandbox",
    baseUrl,
    fixtureExecutor,
    ownerToken,
    demoToken: fixtureExecutor ? demoToken : undefined,
    audit,
    policy,
    approvals,
    mandates,
    registries,
    ownerPrivateKey: keys.ownerPrivate,
    chat: chatClientFromEnv(env),
    chatProvider: env.LLM_BASE_URL && env.LLM_API_KEY ? "custom" : env.CF_ACCOUNT_ID && env.CF_API_TOKEN ? "cloudflare" : undefined,
    notifier,
    sessions: ownerToken ? new SessionManager(ownerToken) : undefined,
    paypalHttp,
    publicUrl,
    now,
    env,
    close: () => {
      if (!o.db) db.close();
    },
  };
  late.rt = rt;
  if (demo) {
    if (!fixtureExecutor || !keys.ownerPrivate) throw new Error("--demo needs the fixture executor and a throw-away owner key");
    rt.demo = { reseed: (o) => seedDemo(rt, o) };
  }
  return rt;
}

/** For `--demo` without an owner token: a random one, printed once, so `pnpm demo` works with no setup. */
export function demoOwnerTokenFallback(env: NodeJS.ProcessEnv): string {
  return env.PAYLEASH_OWNER_TOKEN?.trim() || randomBytes(18).toString("hex");
}

/** Mandate for the stdio transport: PAYLEASH_MANDATE, or the file named by PAYLEASH_MANDATE_FILE. */
export function stdioMandateToken(env: NodeJS.ProcessEnv): string {
  const token = env.PAYLEASH_MANDATE?.trim() || (env.PAYLEASH_MANDATE_FILE ? readFileSync(env.PAYLEASH_MANDATE_FILE, "utf8").trim() : "");
  if (!token) throw new Error("stdio transport needs the agent's mandate: set PAYLEASH_MANDATE (or PAYLEASH_MANDATE_FILE). Issue one with `payleash mandate issue`.");
  return token;
}
