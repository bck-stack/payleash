import type { IncomingMessage, ServerResponse } from "node:http";
import {
  EXAMPLE_SUPPORT_MANDATE,
  MandateInputSchema,
  PolicyDraftError,
  fetchLiveHistory,
  formatMinor,
  groupReasons,
  historyFromFiles,
  mandateToInput,
  parseDecimal,
  parseTtl,
  reasonInfo,
  rerunPolicy,
  runBacktest,
  summarize,
  translatePolicy,
  issueMandate,
  type AuditEntry,
  type BacktestRun,
  type History,
  type MandateInput,
  type PolicyOverrides,
} from "@payleash/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApprovalError } from "./app.js";
import { TOOL_CLASSIFICATION } from "./classification.js";
import { LoginThrottle, SESSION_COOKIE, clearCookieHeader, cookieHeader, parseCookies, type Role } from "./sessions.js";
import { SECURITY_HEADERS } from "./static.js";
import type { ProxyRuntime } from "./runtime.js";
import { safeEqual } from "./http.js";

const MAX_BODY = 1_000_000;
const DAY_MS = 86_400_000;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ApiError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid JSON body");
  }
}

const bearer = (req: IncomingMessage): string | undefined => /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1]?.trim();
const int = (v: string | null, dflt: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.floor(Number(v)) : dflt));

/** The audit log as the dashboard needs it: parsed arguments, the raw reasons (full detail) and the grouped ones. */
export function auditRow(e: AuditEntry) {
  const args = JSON.parse(e.args) as Record<string, unknown>;
  const raw = JSON.parse(e.reasons) as { code: string; message: string }[];
  return {
    seq: e.seq,
    ts: e.ts,
    agent: e.agent,
    tool: e.tool,
    decision: e.decision,
    summary: argSummary(e.tool, args),
    args,
    reasons: raw,
    reasonsGrouped: groupReasons(raw).map((r) => ({ ...r, title: reasonInfo(r.code).title })),
    mandateId: e.mandateId,
    paypalResultId: e.paypalResultId,
    hash: e.hash,
    prevHash: e.prevHash,
  };
}

function argSummary(tool: string, args: Record<string, unknown>): string {
  const money = (a: any) => (a?.amount?.value ? `${a.amount.value} ${a.amount.currency_code ?? ""}`.trim() : "");
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (tool) {
    case "create_refund":
      return [money(args) || "full refund", s(args.capture_id) && `on ${s(args.capture_id)}`, s(args.payee_email) && `to ${s(args.payee_email)}`].filter(Boolean).join(" ");
    case "send_invoice":
    case "send_invoice_reminder":
      return s(args.invoice_id);
    case "accept_dispute_claim":
      return s(args.dispute_id);
    case "cancel_subscription":
      return s(args.subscription_id);
    case "payleash_issue_mandate":
      return `${s(args.agentId)} (${s(args.mandateId)})`;
    case "payleash_freeze":
    case "payleash_unfreeze":
      return args.agentId ? `agent ${s(args.agentId)}` : "all agents";
    default:
      return Object.entries(args).filter(([, v]) => typeof v === "string").slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(" ");
  }
}

const startOfDay = (now: Date, tzOffsetMin: number): Date => {
  // tzOffsetMin is `new Date().getTimezoneOffset()` of the browser: UTC minus local, in minutes.
  const local = new Date(now.getTime() - tzOffsetMin * 60_000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() + tzOffsetMin * 60_000);
};

let fixtureCache: { key: string; history: History | null } | undefined;
const REPO_FIXTURES = fileURLToPath(new URL("../../../scripts/seed-sandbox/fixtures/", import.meta.url));

function loadFixtureHistory(env: NodeJS.ProcessEnv): History | null {
  const historyPath = env.PAYLEASH_BACKTEST_HISTORY?.trim() || `${REPO_FIXTURES}backtest-history.json`;
  const disputesPath = env.PAYLEASH_BACKTEST_DISPUTES?.trim() || `${REPO_FIXTURES}disputes.json`;
  const key = `${historyPath}|${disputesPath}`;
  if (fixtureCache?.key === key) return fixtureCache.history;
  const history = readFixtureHistory(historyPath, disputesPath);
  fixtureCache = { key, history };
  return history;
}

function readFixtureHistory(historyPath: string, disputesPath: string): History | null {
  try {
    const disputes = (() => {
      try {
        return JSON.parse(readFileSync(disputesPath, "utf8"));
      } catch {
        return {};
      }
    })();
    return historyFromFiles(JSON.parse(readFileSync(historyPath, "utf8")), disputes);
  } catch {
    return null;
  }
}

export interface OwnerApi {
  /** Handles any request under /api. Returns false for other paths. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<boolean>;
  /** Role of a request (session cookie, or the owner token as a bearer), or null. */
  authenticate(req: IncomingMessage): Role | null;
}

export function createOwnerApi(rt: ProxyRuntime): OwnerApi {
  const throttle = new LoginThrottle();
  const runs = new Map<string, BacktestRun>();
  let liveCache: { at: number; history: History } | undefined;
  const knownTools = Object.keys(TOOL_CLASSIFICATION);
  const trustProxy = rt.env.PAYLEASH_TRUST_PROXY === "1";
  const inFixtureMode = () => rt.mode === "fixtures";

  const secureCookie = (req: IncomingMessage): boolean =>
    rt.env.PAYLEASH_COOKIE_SECURE === "1" || (trustProxy && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https") || !!(req.socket as { encrypted?: boolean }).encrypted;
  const clientKey = (req: IncomingMessage): string => (trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "unknown";

  function authenticate(req: IncomingMessage): Role | null {
    const given = bearer(req);
    if (given && rt.ownerToken && safeEqual(given, rt.ownerToken)) return "owner";
    return rt.sessions?.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE]) ?? null;
  }

  /** Cookie-authenticated writes must come from this site (SameSite=Strict already stops cross-site cookies; this is the second lock). */
  function sameOrigin(req: IncomingMessage): void {
    if (bearer(req)) return;
    const origin = req.headers.origin;
    if (!origin) return;
    let host = "";
    try {
      host = new URL(String(origin)).host;
    } catch {
      /* "null" and other unparsable origins fall through to the refusal */
    }
    if (host !== String(req.headers.host ?? "")) throw new ApiError(403, "cross-origin request refused");
  }

  const need = (role: Role | null, ...allowed: Role[]): Role => {
    if (!role) throw new ApiError(401, "sign in first");
    if (!allowed.includes(role)) throw new ApiError(403, role === "demo" ? "the demo account is read-only here" : "not allowed");
    return role;
  };

  // ---- data builders ------------------------------------------------------

  function overview(tzOffsetMin: number) {
    const now = rt.now();
    const nowSec = Math.floor(now.getTime() / 1000);
    const dayStart = startOfDay(now, tzOffsetMin);
    const counts = rt.audit.decisionCountsSince(dayStart.toISOString());
    const frozen = rt.policy.frozenScopes();
    const global = frozen.find((f) => f.scope === "global");
    const ids = new Set<string>([...rt.mandates.agentIds(), ...counts.map((c) => c.agent).filter((a) => a !== "unknown" && a !== "*")]);
    const agents = [...ids].sort().map((agentId) => {
      const known = rt.mandates.current(agentId, nowSec);
      const m = known?.mandate;
      const state = !m ? "none" : nowSec < m.notBefore ? "not_yet_valid" : nowSec >= m.expiresAt ? "expired" : "valid";
      const budgets = m
        ? Object.entries(m.constraints)
            .filter(([, c]) => c.dailyTotal && c.currency)
            .map(([tool, c]) => {
              const cur = c.currency!;
              const limit = parseDecimal(c.dailyTotal!, cur);
              const used = rt.policy.spentSince(agentId, tool, cur, now.getTime() - DAY_MS);
              return { tool, currency: cur, limitMinor: limit, usedMinor: used, limit: formatMinor(limit, cur), used: formatMinor(used, cur), remaining: formatMinor(Math.max(0, limit - used), cur), percent: limit ? Math.min(100, Math.round((used / limit) * 100)) : 0 };
            })
        : [];
      const n = (d: string) => counts.find((c) => c.agent === agentId && c.decision === d)?.n ?? 0;
      const af = frozen.find((f) => f.scope === `agent:${agentId}`);
      return {
        agentId,
        mandate: m
          ? {
              id: m.id,
              state,
              source: known!.source,
              notBefore: new Date(m.notBefore * 1000).toISOString(),
              expiresAt: new Date(m.expiresAt * 1000).toISOString(),
              daysLeft: Math.max(0, Math.ceil((m.expiresAt - nowSec) / 86400)),
              allowedTools: m.allowedTools,
              constraints: m.constraints,
            }
          : null,
        budgets,
        today: { allow: n("allow"), hold: n("hold"), deny: n("deny") },
        frozen: !!af || !!global,
        frozenScope: global ? "global" : af ? "agent" : null,
        frozenReason: (global ?? af)?.reason ?? null,
        pending: rt.approvals.countPending(agentId),
      };
    });
    return {
      now: now.toISOString(),
      dayStart: dayStart.toISOString(),
      mode: rt.mode,
      frozen: { global: global ? { reason: global.reason, since: new Date(global.frozenAtMs).toISOString() } : null, agents: frozen.filter((f) => f.scope.startsWith("agent:")).map((f) => ({ agentId: f.scope.slice(6), reason: f.reason, since: new Date(f.frozenAtMs).toISOString() })) },
      agents,
      pendingTotal: rt.approvals.countPending(),
      audit: rt.audit.head(),
    };
  }

  const policyFor = (agentId: string): MandateInput | null => {
    const known = rt.mandates.current(agentId);
    return known ? mandateToInput(known.mandate) : null;
  };

  async function loadHistory(source: string): Promise<History> {
    if (source === "live") {
      if (!rt.paypalHttp) throw new ApiError(400, "Live history needs the sandbox credentials. This server runs on recorded PayPal data: use the recorded 90-day history.");
      if (liveCache && Date.now() - liveCache.at < 15 * 60_000) return liveCache.history;
      try {
        const history = await fetchLiveHistory(rt.paypalHttp);
        liveCache = { at: Date.now(), history };
        return history;
      } catch (e) {
        throw new ApiError(502, e instanceof Error ? e.message : String(e));
      }
    }
    const h = loadFixtureHistory(rt.env);
    if (!h) throw new ApiError(404, "The recorded history file was not found (scripts/seed-sandbox/fixtures/backtest-history.json). Set PAYLEASH_BACKTEST_HISTORY.");
    return h;
  }

  const parseMandateInput = (raw: unknown): MandateInput => {
    const parsed = MandateInputSchema.strict().safeParse(raw);
    if (!parsed.success) throw new ApiError(422, "not a valid mandate", parsed.error.issues.map((i) => `${i.path.join(".") || "mandate"}: ${i.message}`));
    return parsed.data;
  };

  // ---- routes -----------------------------------------------------------------

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
    const method = req.method ?? "GET";
    const role = authenticate(req);
    const q = url.searchParams;

    if (path === "/api/login" && method === "POST") {
      if (!rt.sessions || !rt.ownerToken) throw new ApiError(503, "the dashboard login is disabled: set PAYLEASH_OWNER_TOKEN");
      const key = clientKey(req);
      if (throttle.blocked(key)) throw new ApiError(429, "too many failed attempts, try again in a few minutes");
      const body = await readJson(req);
      const token = typeof body.token === "string" ? body.token.trim() : "";
      const who: Role | null = token && safeEqual(token, rt.ownerToken) ? "owner" : token && rt.demoToken && safeEqual(token, rt.demoToken) ? "demo" : null;
      if (!who) {
        throttle.fail(key);
        throw new ApiError(401, "that token is not right");
      }
      throttle.ok(key);
      const c = rt.sessions.issue(who);
      return send(res, 200, { ok: true, role: who }, { "Set-Cookie": cookieHeader(c.value, c.maxAgeSeconds, secureCookie(req)) });
    }
    if (path === "/api/logout" && method === "POST") return send(res, 200, { ok: true }, { "Set-Cookie": clearCookieHeader(secureCookie(req)) });

    if (path === "/api/me" && method === "GET") {
      return send(res, 200, {
        authenticated: !!role,
        role,
        mode: rt.mode,
        demo: inFixtureMode(),
        loginEnabled: !!rt.sessions,
        demoLoginAvailable: !!rt.demoToken,
        canApprove: role === "owner" || (role === "demo" && inFixtureMode()),
        canSign: role === "owner" && !!rt.ownerPrivateKey,
        canFreeze: role === "owner",
        llm: { configured: !!rt.chat, provider: rt.chatProvider ?? null },
        push: { enabled: rt.notifier.pushEnabled, publicKey: rt.notifier.publicKey ?? null, subscriptions: role === "owner" ? rt.notifier.subscriptions().length : 0 },
        email: rt.notifier.emailEnabled,
        backtest: { fixtures: !!loadFixtureHistory(rt.env), live: !!rt.paypalHttp },
      });
    }

    // Everything below needs a session.
    need(role, "owner", "demo");
    if (method !== "GET" && method !== "HEAD") sameOrigin(req);

    if (path === "/api/overview" && method === "GET") return send(res, 200, overview(int(q.get("tz"), 0, -840, 840)));

    if (path === "/api/approvals" && method === "GET") {
      const status = q.get("status") ?? undefined;
      if (status && !["pending", "approving", "executed", "failed", "denied", "expired"].includes(status)) throw new ApiError(400, "unknown status");
      return send(res, 200, { approvals: rt.app.listOwnerApprovals(status as never) });
    }
    const am = /^\/api\/approvals\/([A-Za-z0-9_-]+)$/.exec(path);
    if (am && method === "POST") {
      const r = need(role, "owner", "demo");
      if (r === "demo" && !inFixtureMode()) throw new ApiError(403, "the demo account can only decide on the seeded demo data");
      const body = await readJson(req);
      const decision = body.decision;
      if (decision !== "approve" && decision !== "deny") throw new ApiError(400, 'body must be {"decision":"approve"} or {"decision":"deny"}');
      await rt.app.decide(am[1]!, decision, typeof body.note === "string" ? `${r === "demo" ? "[demo] " : ""}${body.note}` : r === "demo" ? "[demo account]" : undefined);
      const view = rt.app.listOwnerApprovals().find((x) => x.approvalId === am[1]);
      return send(res, 200, view ?? { ok: true });
    }

    if ((path === "/api/freeze" || path === "/api/unfreeze") && method === "POST") {
      need(role, "owner");
      const body = await readJson(req);
      const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;
      if (path === "/api/freeze") rt.app.freeze(agentId, typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined);
      else rt.app.unfreeze(agentId);
      return send(res, 200, { ok: true, scope: agentId ? `agent:${agentId}` : "global", frozen: path === "/api/freeze" });
    }

    if (path === "/api/audit" && method === "GET") {
      const afterSeq = q.get("afterSeq");
      const rows = rt.audit.page({ afterSeq: afterSeq === null ? undefined : int(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER), limit: int(q.get("limit"), 500, 1, 5000), agent: q.get("agent") ?? undefined }).map(auditRow);
      return send(res, 200, { entries: rows, head: rt.audit.head() });
    }
    if (path === "/api/audit/verify" && method === "GET") return send(res, 200, rt.app.verifyAudit(q.get("head") ?? undefined));

    if (path === "/api/events" && method === "GET") return sse(req, res, q.get("afterSeq"));

    // ---- policies
    if (path === "/api/policies" && method === "GET") {
      const agentIds = new Set([...rt.mandates.agentIds()]);
      return send(res, 200, {
        agents: [...agentIds].sort().map((agentId) => {
          const known = rt.mandates.current(agentId)!;
          return { agentId, current: mandateToInput(known.mandate), mandateId: known.mandate.id, expiresAt: new Date(known.mandate.expiresAt * 1000).toISOString() };
        }),
        tools: knownTools.sort().map((tool) => ({ tool, access: TOOL_CLASSIFICATION[tool] })),
        canSign: role === "owner" && !!rt.ownerPrivateKey,
        llm: { configured: !!rt.chat, provider: rt.chatProvider ?? null },
        example: "Support agent may refund up to $100 per order, at most $300 a day, automatically up to $25; only orders from the last 60 days",
      });
    }
    if (path === "/api/policies/draft" && method === "POST") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text : "";
      const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : undefined;
      try {
        const draft = await translatePolicy(text, { knownTools, chat: rt.chat, agentId, current: agentId ? policyFor(agentId) : null, onLlmError: (e) => rt.env.PAYLEASH_QUIET || process.stderr.write(`[payleash] policy LLM failed: ${e instanceof Error ? e.message : String(e)}\n`) });
        const current = policyFor(draft.proposed.agentId);
        // Never signed here: the owner confirms on the next step.
        return send(res, 200, { ...draft, current, signed: false });
      } catch (e) {
        if (e instanceof PolicyDraftError) throw new ApiError(422, e.message, e.problems);
        throw e;
      }
    }
    if (path === "/api/policies/issue" && method === "POST") {
      need(role, "owner");
      const body = await readJson(req);
      if (body.confirm !== true) throw new ApiError(400, "confirm: true is required: a mandate is only signed after you confirm it");
      if (!rt.ownerPrivateKey) throw new ApiError(409, "the owner key is not on this server. Sign it on your machine: payleash mandate issue --file mandate.json");
      const input = parseMandateInput(body.mandate);
      for (const t of input.allowedTools) if (!knownTools.includes(t)) throw new ApiError(422, `unknown tool "${t}"`);
      let ttlSeconds: number;
      try {
        ttlSeconds = parseTtl(typeof body.ttl === "string" ? body.ttl : "30d");
      } catch (e) {
        throw new ApiError(400, e instanceof Error ? e.message : String(e));
      }
      if (ttlSeconds < 60 || ttlSeconds > 365 * 86400) throw new ApiError(400, "validity must be between 1 minute and 365 days");
      const { token, mandate } = await issueMandate(rt.ownerPrivateKey, input, { issuer: "payleash-dashboard", ttlSeconds, now: rt.now() });
      rt.mandates.record(mandate, "issued", rt.now().getTime());
      rt.audit.append({ agent: mandate.agentId, tool: "payleash_issue_mandate", args: { mandateId: mandate.id, agentId: mandate.agentId, allowedTools: mandate.allowedTools, constraints: mandate.constraints }, decision: "mandate_issued", reasons: [{ code: "owner_approved", message: "The owner signed this mandate from the dashboard." }], mandateId: mandate.id, ts: rt.now() });
      // The token is shown once and never stored: it is the agent's credential.
      return send(res, 200, { token, mandate: { id: mandate.id, agentId: mandate.agentId, expiresAt: new Date(mandate.expiresAt * 1000).toISOString() } });
    }

    // ---- backtest
    if (path === "/api/backtest/defaults" && method === "GET") {
      const agents = rt.mandates.agentIds().map((agentId) => ({ agentId, mandate: policyFor(agentId)! }));
      return send(res, 200, { sources: { fixtures: !!loadFixtureHistory(rt.env), live: !!rt.paypalHttp }, agents, defaultMandate: EXAMPLE_SUPPORT_MANDATE });
    }
    if (path === "/api/backtest/run" && method === "POST") {
      const body = await readJson(req);
      const source = body.source === "live" ? "live" : "fixtures";
      if (source === "live" && role === "demo") throw new ApiError(403, "the demo account uses the recorded history");
      const mandate = body.mandate ? parseMandateInput(body.mandate) : typeof body.agentId === "string" && policyFor(body.agentId) ? policyFor(body.agentId)! : EXAMPLE_SUPPORT_MANDATE;
      const sample = body.sampleOrders === undefined ? undefined : int(String(body.sampleOrders), 40, 0, 150);
      const history = await loadHistory(source);
      const run = await runBacktest({ history, mandate, options: { sampleOrders: sample, adversarial: body.adversarial === false ? false : undefined, seed: body.seed === undefined ? undefined : int(String(body.seed), 11, 0, 1_000_000) } });
      runs.set(run.id, run);
      while (runs.size > 8) runs.delete(runs.keys().next().value!);
      const { results: _results, ...summary } = run;
      return send(res, 200, { ...summary, mandateInput: mandateToInput(run.mandate), thresholdDefault: run.mandate.constraints.create_refund?.autoApproveThreshold ?? null, maxPerOp: run.mandate.constraints.create_refund?.maxAmountPerOp ?? null });
    }
    if (path === "/api/backtest/whatif" && method === "POST") {
      const body = await readJson(req);
      const run = typeof body.runId === "string" ? runs.get(body.runId) : undefined;
      if (!run) throw new ApiError(404, "that backtest is no longer in memory: run it again");
      const overrides: PolicyOverrides = {};
      for (const k of ["autoApproveThreshold", "maxAmountPerOp", "dailyTotal"] as const) {
        const v = body[k];
        if (v === undefined || v === null || v === "") continue;
        if (typeof v !== "string" && typeof v !== "number") throw new ApiError(400, `${k} must be an amount`);
        try {
          const text = typeof v === "number" ? v.toFixed(2) : v;
          parseDecimal(text, run.mandate.constraints.create_refund?.currency ?? "USD");
          overrides[k] = text;
        } catch {
          throw new ApiError(400, `${k} is not a valid amount`);
        }
      }
      const results = rerunPolicy(run.results, run.mandate, overrides);
      return send(res, 200, { runId: run.id, overrides, report: summarize(results), decisions: Object.fromEntries(results.map((r) => [r.action.id, { decision: r.decision, rules: r.reasons.map((x) => x.code).join(", ") }])) });
    }

    // ---- notifications
    if (path === "/api/push/config" && method === "GET") return send(res, 200, { enabled: rt.notifier.pushEnabled, publicKey: rt.notifier.publicKey ?? null, email: rt.notifier.emailEnabled });
    if (path === "/api/push/subscribe" && method === "POST") {
      need(role, "owner");
      if (!rt.notifier.pushEnabled) throw new ApiError(409, "Web Push is not set up on this server: run `payleash vapid init`");
      const body = await readJson(req);
      try {
        rt.notifier.subscribe(body.subscription as never, typeof body.label === "string" ? body.label : undefined);
      } catch (e) {
        throw new ApiError(400, e instanceof Error ? e.message : String(e));
      }
      return send(res, 200, { ok: true });
    }
    if (path === "/api/push/unsubscribe" && method === "POST") {
      need(role, "owner");
      const body = await readJson(req);
      return send(res, 200, { ok: true, removed: typeof body.endpoint === "string" && rt.notifier.unsubscribe(body.endpoint) });
    }
    if (path === "/api/push/test" && method === "POST") {
      need(role, "owner");
      return send(res, 200, await rt.notifier.sendTest());
    }

    // ---- demo
    if (path === "/api/demo/reseed" && method === "POST") {
      need(role, "owner", "demo");
      if (!rt.demo) throw new ApiError(404, "this server is not running --demo");
      await rt.demo.reseed();
      return send(res, 200, { ok: true, pending: rt.approvals.countPending() });
    }

    throw new ApiError(404, "not found");
  }

  /** Server-sent events: new audit entries and the pending count, polled from the database once a second. */
  function sse(req: IncomingMessage, res: ServerResponse, afterSeq: string | null): void {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no", ...SECURITY_HEADERS });
    res.write("retry: 3000\n\n");
    let last = afterSeq !== null ? int(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER) : rt.audit.head().seq;
    let pending = -1;
    const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const tick = () => {
      try {
        for (const e of rt.audit.page({ afterSeq: last, limit: 100 })) {
          write("audit", auditRow(e));
          last = e.seq;
        }
        const n = rt.approvals.countPending();
        if (n !== pending) {
          pending = n;
          write("pending", { pending: n });
        }
      } catch {
        /* the database may be closing */
      }
    };
    tick();
    const poll = setInterval(tick, 1000);
    const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
    const stop = () => {
      clearInterval(poll);
      clearInterval(beat);
    };
    req.on("close", stop);
    res.on("close", stop);
  }

  return {
    authenticate,
    async handle(req, res, url, path) {
      if (!path.startsWith("/api/") && path !== "/api") return false;
      try {
        await route(req, res, url, path);
      } catch (e) {
        if (res.headersSent) return res.end(), true;
        if (e instanceof ApiError) send(res, e.status, { error: e.message, ...(e.details ? { details: e.details } : {}) });
        else if (e instanceof ApprovalError) send(res, e.httpStatus, { error: e.message });
        else {
          send(res, 500, { error: "internal error" });
          process.stderr.write(`[payleash] api error: ${e instanceof Error ? e.stack : String(e)}\n`);
        }
      }
      return true;
    },
  };
}

