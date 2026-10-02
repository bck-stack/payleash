import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultKeyDir, initKeys, loadPrivateKey, loadPublicKey } from "./keys.js";
import { initVapid } from "./vapid.js";
import { MandateRegistry } from "./mandate/registry.js";
import { AuditLog } from "./audit/index.js";
import { openDb, resolveDbPath } from "./db.js";
import { issueMandate, verifyMandate } from "./mandate/index.js";
import { PayPalHttp, SANDBOX_BASE_URL, refreshAccessToken } from "./paypal/http.js";
import { historyFromFiles, rerunPolicy, runBacktest, summarize } from "./backtest/index.js";
import { SqlitePolicyStore } from "./policy/index.js";

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export const defaultIo: CliIo = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  env: process.env,
};

const USAGE = `payleash <command>

  keys init [--dir D] [--force] [--allow-in-repo]   generate the owner + step-up Ed25519 keys (outside the repo)
  mandate issue --file F [--ttl 30d] [--issuer NAME] [--key-dir D] [--record]
                                                   sign an operation mandate; prints the token. With --record (or PAYLEASH_DB_PATH
                                                   set) its claims are also saved so the dashboard can show them
  vapid init --subject mailto:you@example.com [--dir D] [--force]
                                                   generate the Web Push (VAPID) keys for dashboard notifications, outside the repo
  mandate verify (--token T | --file F) [--key-dir D]
                                                   verify a mandate and print its claims
  freeze [--agent ID] [--reason TEXT]               kill switch: deny every write tool (globally, or for one agent)
  unfreeze [--agent ID]                             lift a freeze
  status [--agent ID]                               show freeze state and 24h budgets

  paypal refresh-token                              terminate PayPal's cached sandbox access token and fetch a new one
                                                   (needed after you change the app's permissions in the developer dashboard)

  backtest --mandate F [--history F] [--disputes F] [--threshold X] [--json]
                                                   replay a 90-day history through the guard (dry run) and print what would run,
                                                   be held or be denied; --threshold re-runs the policy only with that auto-approve limit

  audit verify [--db PATH] [--head HASH]            recompute the audit hash chain; exit 1 if anything was tampered with
  audit head [--db PATH]                            print "seq hash" of the newest entry (record it elsewhere to detect truncation)
  audit tail [--db PATH] [-n 20]                    show the newest entries

The database path comes from PAYLEASH_DB_PATH (default ./payleash.db).
`;

export function parseTtl(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`invalid --ttl "${s}" (examples: 3600s, 90m, 12h, 30d)`);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * mult;
}

type Command = (args: string[], io: CliIo) => Promise<number>;
const commands = new Map<string, Command>();
export function registerCommand(name: string, fn: Command): void {
  commands.set(name, fn);
}

registerCommand("keys init", async (args, io) => {
  const { values } = parseArgs({
    args,
    options: { dir: { type: "string" }, force: { type: "boolean" }, "allow-in-repo": { type: "boolean" } },
  });
  const dir = values.dir ?? defaultKeyDir(io.env);
  const res = initKeys({ dir, force: values.force, allowInRepo: values["allow-in-repo"] });
  io.out(`Keys written to ${res.dir}`);
  for (const f of res.files) io.out(`  ${f}`);
  io.out("");
  io.out(`export PAYLEASH_KEY_DIR=${res.dir}`);
  io.out("Keep owner.key.pem private. The proxy only needs owner.pub.pem and the stepup key pair.");
  return 0;
});

registerCommand("mandate issue", async (args, io) => {
  const { values } = parseArgs({
    args,
    options: { file: { type: "string" }, ttl: { type: "string" }, issuer: { type: "string" }, "key-dir": { type: "string" }, record: { type: "boolean" } },
  });
  if (!values.file) throw new Error("--file is required");
  const input = JSON.parse(readFileSync(values.file, "utf8"));
  const dir = values["key-dir"] ?? defaultKeyDir(io.env);
  const { token, mandate } = await issueMandate(loadPrivateKey(dir, "owner"), input, {
    issuer: values.issuer ?? "payleash-owner",
    ttlSeconds: parseTtl(values.ttl ?? input.ttl ?? "30d"),
  });
  io.err(`mandate ${mandate.id} for agent "${mandate.agentId}" valid until ${new Date(mandate.expiresAt * 1000).toISOString()}`);
  if (values.record || io.env.PAYLEASH_DB_PATH) {
    const db = openDb(resolveDbPath(io.env));
    try {
      new MandateRegistry(db).record(mandate, "issued");
    } finally {
      db.close();
    }
    io.err("claims recorded for the dashboard (the token itself is not stored)");
  }
  io.out(token);
  return 0;
});

registerCommand("vapid init", async (args, io) => {
  const { values } = parseArgs({ args, options: { dir: { type: "string" }, subject: { type: "string" }, force: { type: "boolean" }, "allow-in-repo": { type: "boolean" } } });
  if (!values.subject) throw new Error('--subject is required, e.g. --subject mailto:you@example.com');
  const r = initVapid({ dir: values.dir ?? defaultKeyDir(io.env), subject: values.subject, force: values.force, allowInRepo: values["allow-in-repo"] });
  io.out(`VAPID keys written to ${r.file}`);
  io.out("The proxy loads them from PAYLEASH_KEY_DIR. On a host without a persistent disk, set instead:");
  io.out(`  PAYLEASH_VAPID_PUBLIC=${r.keys.publicKey}`);
  io.out(`  PAYLEASH_VAPID_SUBJECT=${r.keys.subject}`);
  io.out("  PAYLEASH_VAPID_PRIVATE=<the privateKey in vapid.json; keep it secret>");
  return 0;
});

registerCommand("mandate verify", async (args, io) => {
  const { values } = parseArgs({ args, options: { token: { type: "string" }, file: { type: "string" }, "key-dir": { type: "string" } } });
  const token = values.token ?? (values.file ? readFileSync(values.file, "utf8") : undefined);
  if (!token) throw new Error("--token or --file is required");
  const dir = values["key-dir"] ?? defaultKeyDir(io.env);
  const mandate = await verifyMandate(token, loadPublicKey(dir, "owner"));
  io.out(JSON.stringify(mandate, null, 2));
  return 0;
});

const withAudit = <T>(io: CliIo, dbPath: string | undefined, fn: (log: AuditLog) => T): T => {
  const db = openDb(dbPath ?? resolveDbPath(io.env));
  try {
    return fn(new AuditLog(db));
  } finally {
    db.close();
  }
};

registerCommand("audit verify", async (args, io) => {
  const { values } = parseArgs({ args, options: { db: { type: "string" }, head: { type: "string" } } });
  const r = withAudit(io, values.db, (log) => log.verify({ expectedHead: values.head }));
  if (r.ok) {
    io.out(`audit log OK: ${r.entries} entries, head #${r.headSeq} ${r.headHash}`);
    return 0;
  }
  io.err(`AUDIT LOG TAMPERING DETECTED (${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}):`);
  for (const p of r.problems) io.err(`  #${p.seq} ${p.problem}: ${p.message}`);
  return 1;
});

registerCommand("audit head", async (args, io) => {
  const { values } = parseArgs({ args, options: { db: { type: "string" } } });
  const h = withAudit(io, values.db, (log) => log.head());
  io.out(`${h.seq} ${h.hash}`);
  return 0;
});

registerCommand("audit tail", async (args, io) => {
  const { values } = parseArgs({ args, options: { db: { type: "string" }, n: { type: "string", short: "n" } } });
  for (const e of withAudit(io, values.db, (log) => log.entries({ limit: Number(values.n ?? 20) }))) {
    io.out(`#${e.seq} ${e.ts} ${e.agent} ${e.tool} ${e.decision}${e.paypalResultId ? ` -> ${e.paypalResultId}` : ""}`);
  }
  return 0;
});

registerCommand("backtest", async (args, io) => {
  const { values } = parseArgs({
    args,
    options: { mandate: { type: "string" }, history: { type: "string" }, disputes: { type: "string" }, threshold: { type: "string" }, json: { type: "boolean" } },
  });
  if (!values.mandate) throw new Error("--mandate FILE is required (the mandate JSON you would issue)");
  const historyPath = values.history ?? "scripts/seed-sandbox/fixtures/backtest-history.json";
  const disputesPath = values.disputes ?? "scripts/seed-sandbox/fixtures/disputes.json";
  const history = historyFromFiles(JSON.parse(readFileSync(historyPath, "utf8")), JSON.parse(readFileSync(disputesPath, "utf8")));
  const run = await runBacktest({ history, mandate: JSON.parse(readFileSync(values.mandate, "utf8")) });
  const results = values.threshold ? rerunPolicy(run.results, run.mandate, { autoApproveThreshold: values.threshold }) : run.results;
  const report = values.threshold ? summarize(results) : run.report;
  if (values.json) {
    io.out(JSON.stringify(report, null, 2));
    return 0;
  }
  const t = report.totals;
  io.out(`${t.actions} replayed actions${values.threshold ? ` (auto-approve threshold ${values.threshold})` : ""}: ${t.allow} automatic, ${t.hold} held, ${t.deny} denied`);
  for (const [cur, m] of Object.entries(report.money)) io.out(`${cur}: ${m.allowed} moved automatically, ${m.held} held for approval, ${m.denied} blocked`);
  io.out(`injection and attack cases caught: ${report.adversarial.caught}/${report.adversarial.total}${report.adversarial.missed.length ? `  MISSED: ${report.adversarial.missed.map((m) => m.id).join(", ")}` : ""}`);
  io.out("rules that fired:");
  for (const h of report.ruleHits) io.out(`  ${String(h.actions).padStart(3)}  ${h.code}`);
  return report.adversarial.missed.length ? 1 : 0;
});

registerCommand("paypal refresh-token", async (_args, io) => {
  const clientId = io.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = io.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox REST app credentials) must be set");
  // Sandbox only: PayPalHttp refuses any other host.
  const http = new PayPalHttp({ baseUrl: io.env.PAYPAL_BASE_URL?.trim() || SANDBOX_BASE_URL, clientId, clientSecret, fetch: io.fetch });
  const r = await refreshAccessToken(http);
  io.out(`terminate: HTTP ${r.terminated.status}${r.terminated.ok ? " (ok)" : ` (failed: ${r.terminated.body || "no body"})`}`);
  io.out(`new token: ${r.replaced ? "a different token was issued" : "PayPal returned the SAME token (it was not terminated)"}, valid for ${r.after.expiresInSeconds}s`);
  io.out(`scopes now (${r.after.scopes.length}):`);
  for (const s of r.after.scopes) io.out(`  ${s.replace("https://uri.paypal.com/services/", "")}${r.scopesAdded.includes(s) ? "   <- new" : ""}`);
  for (const s of r.scopesRemoved) io.out(`  removed: ${s}`);
  if (!r.terminated.ok || !r.replaced) {
    io.err("The token was not replaced. See docs/SMOKE-TEST.md, 'Permission changes do not apply'.");
    return 1;
  }
  return 0;
});

const withStore = <T>(io: CliIo, fn: (store: SqlitePolicyStore) => T): T => {
  const db = openDb(resolveDbPath(io.env));
  try {
    return fn(new SqlitePolicyStore(db));
  } finally {
    db.close();
  }
};

registerCommand("freeze", async (args, io) => {
  const { values } = parseArgs({ args, options: { agent: { type: "string" }, reason: { type: "string" } } });
  withStore(io, (s) => s.freeze({ agentId: values.agent }, values.reason));
  io.out(values.agent ? `agent "${values.agent}" frozen: every write tool is denied` : "GLOBAL FREEZE on: every write tool is denied for every agent");
  return 0;
});

registerCommand("unfreeze", async (args, io) => {
  const { values } = parseArgs({ args, options: { agent: { type: "string" } } });
  const changed = withStore(io, (s) => s.unfreeze({ agentId: values.agent }));
  io.out(changed ? "freeze lifted" : "nothing was frozen at that scope");
  return 0;
});

registerCommand("status", async (args, io) => {
  const { values } = parseArgs({ args, options: { agent: { type: "string" } } });
  withStore(io, (s) => {
    const scopes = s.frozenScopes();
    io.out(scopes.length ? `frozen: ${scopes.map((f) => f.scope + (f.reason ? ` (${f.reason})` : "")).join(", ")}` : "frozen: nothing");
    if (values.agent) io.out(JSON.stringify(s.summary(values.agent), null, 2));
  });
  return 0;
});

/** Returns the process exit code. */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const two = commands.get(`${argv[0]} ${argv[1]}`);
  const cmd = two ?? commands.get(argv[0] ?? "");
  const rest = argv.slice(two ? 2 : 1);
  const [a] = argv;
  if (!cmd) {
    io.err(USAGE);
    return a === "help" || a === "--help" || a === undefined ? 0 : 2;
  }
  try {
    return await cmd(rest, io);
  } catch (e) {
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
