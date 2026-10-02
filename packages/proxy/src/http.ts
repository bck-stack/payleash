import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ApprovalError } from "./app.js";
import { createOwnerApi } from "./owner-api.js";
import type { ProxyRuntime } from "./runtime.js";
import { createMcpServer } from "./server.js";
import { serveDashboard } from "./static.js";

const MAX_BODY = 1_000_000;
const MAX_SESSIONS = 200;

const digest = (s: string) => createHash("sha256").update(s).digest();
export const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const bearer = (req: IncomingMessage): string | undefined => /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1]?.trim();

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ApprovalError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApprovalError(400, "invalid JSON body");
  }
}

export interface HttpOptions {
  host: string;
  port: number;
  /** Serve the MCP endpoint at /mcp. Off when MCP runs over stdio. */
  mcp: boolean;
  /** Built dashboard to serve at /. */
  dashboardDir?: string;
}

export interface RunningHttp {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/**
 * HTTP surface:
 *   /mcp                     MCP streamable HTTP; the agent's mandate is its `Authorization: Bearer` credential
 *   POST /approvals/:id      owner: {"decision":"approve"|"deny"} (also {"approve":true} / {"deny":true})
 *   GET  /approvals[/:id]    owner: list / view
 *   POST /freeze, /unfreeze  owner: kill switch, {"agentId"?, "reason"?}
 *   GET  /audit/verify       owner: recompute the audit chain
 *   GET  /healthz
 *   /api/*                   dashboard API: session cookie (login with the owner token) or the owner token as bearer
 *   /                        the built dashboard, when `dashboardDir` is set
 * Owner endpoints need `Authorization: Bearer $PAYLEASH_OWNER_TOKEN` and are disabled when it is unset.
 */
export async function startHttp(rt: ProxyRuntime, o: HttpOptions): Promise<RunningHttp> {
  const { app } = rt;
  const api = createOwnerApi(rt);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mandateToken: string }>();

  const startedAtMs = Date.now();
  /** Cheap and public: no secrets, no PayPal call. Render's health check and the uptime script read it. */
  const health = (): [number, Record<string, unknown>] => {
    try {
      const audit = rt.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
      return [
        200,
        {
          ok: true,
          mode: rt.mode,
          demo: !!rt.demo,
          tools: rt.tools.length,
          uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
          now: rt.now().toISOString(),
          audit: { entries: audit.n },
          pending: rt.approvals.countPending(),
          ...(rt.demoStatus ? { reset: { last: rt.demoStatus.lastResetAt, next: rt.demoStatus.nextResetAt, count: rt.demoStatus.resets } } : {}),
        },
      ];
    } catch {
      return [503, { ok: false, error: "database unavailable" }];
    }
  };

  const ownerOnly = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!rt.ownerToken) {
      send(res, 503, { error: "owner API is disabled: set PAYLEASH_OWNER_TOKEN" });
      return false;
    }
    const given = bearer(req);
    if (!given || !safeEqual(given, rt.ownerToken)) {
      send(res, 401, { error: "owner authentication required" }, { "WWW-Authenticate": 'Bearer realm="payleash-owner"' });
      return false;
    }
    return true;
  };

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = bearer(req);
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const body = req.method === "POST" ? await readJson(req) : undefined;

    if (sid) {
      const s = sessions.get(sid);
      if (!s) return send(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "unknown session" }, id: null });
      if (!token || !safeEqual(token, s.mandateToken)) return send(res, 401, { error: "mandate does not match this session" });
      return s.transport.handleRequest(req, res, body);
    }
    if (req.method === "POST" && isInitializeRequest(body)) {
      if (!token) return send(res, 401, { error: "send the agent's mandate as 'Authorization: Bearer <mandate>'" }, { "WWW-Authenticate": 'Bearer realm="payleash-mandate"' });
      if (sessions.size >= MAX_SESSIONS) return send(res, 503, { error: "too many sessions" });
      let session;
      try {
        session = await app.openSession(token);
      } catch (e) {
        return send(res, 401, { error: `mandate rejected: ${e instanceof Error ? e.message : String(e)}` }, { "WWW-Authenticate": 'Bearer realm="payleash-mandate", error="invalid_token"' });
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, { transport, mandateToken: token }),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await createMcpServer({ app, session, tools: rt.tools }).connect(transport);
      return transport.handleRequest(req, res, body);
    }
    send(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "no session: send an initialize request first" }, id: null });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if ((path === "/healthz" || path === "/api/health") && req.method === "GET") return send(res, ...health());
    if (path === "/mcp" && o.mcp) return handleMcp(req, res);
    if (await api.handle(req, res, url, path)) return;
    // A browser opening /approvals (a link from a notification, a reload) wants the page, not the owner API's JSON of the same name.
    if (o.dashboardDir && req.method === "GET" && /text\/html/.test(String(req.headers.accept ?? "")) && !bearer(req) && serveDashboard(o.dashboardDir, req, res, path)) return;

    const m = /^\/approvals\/([A-Za-z0-9_-]+)$/.exec(path);
    if (path === "/approvals" && req.method === "GET") {
      if (!ownerOnly(req, res)) return;
      const status = url.searchParams.get("status") ?? undefined;
      return send(res, 200, { approvals: app.listApprovals(status as never) });
    }
    if (m && req.method === "GET") {
      if (!ownerOnly(req, res)) return;
      const a = app.listApprovals().find((x) => x.approvalId === m[1]);
      return a ? send(res, 200, a) : send(res, 404, { error: "unknown approval" });
    }
    if (m && req.method === "POST") {
      if (!ownerOnly(req, res)) return;
      const body = ((await readJson(req)) ?? {}) as { decision?: string; approve?: boolean; deny?: boolean; note?: string };
      const decision = body.decision ?? (body.approve ? "approve" : body.deny ? "deny" : undefined);
      if (decision !== "approve" && decision !== "deny") return send(res, 400, { error: 'body must be {"decision":"approve"} or {"decision":"deny"}' });
      return send(res, 200, await app.decide(m[1]!, decision, typeof body.note === "string" ? body.note : undefined));
    }
    if ((path === "/freeze" || path === "/unfreeze") && req.method === "POST") {
      if (!ownerOnly(req, res)) return;
      const body = ((await readJson(req)) ?? {}) as { agentId?: string; reason?: string };
      if (path === "/freeze") app.freeze(body.agentId, body.reason);
      else app.unfreeze(body.agentId);
      return send(res, 200, { ok: true, scope: body.agentId ? `agent:${body.agentId}` : "global", frozen: path === "/freeze" });
    }
    if (path === "/audit/verify" && req.method === "GET") {
      if (!ownerOnly(req, res)) return;
      return send(res, 200, app.verifyAudit(url.searchParams.get("head") ?? undefined));
    }
    if (o.dashboardDir && serveDashboard(o.dashboardDir, req, res, path)) return;
    send(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof ApprovalError) return send(res, e.httpStatus, { error: e.message });
      send(res, 500, { error: "internal error" });
      process.stderr.write(`[payleash] http error: ${e instanceof Error ? e.stack : String(e)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, resolve);
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    url: `http://${o.host === "0.0.0.0" ? "127.0.0.1" : o.host}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions.values()) void s.transport.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
