import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startHttp, type RunningHttp } from "../src/index.js";
import { I, SUPPORT_MANDATE, makeRuntime, mandateToken } from "./helpers.js";

const OWNER = "owner-token-0123456789abcdef";
let running: RunningHttp | undefined;
let clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  clients = [];
  await running?.close();
  running = undefined;
});

async function boot(env: NodeJS.ProcessEnv = {}) {
  const rt = makeRuntime(env);
  running = await startHttp(rt, { host: "127.0.0.1", port: 0, mcp: true });
  return { rt, url: running.url };
}
async function agent(url: string, token: string) {
  const client = new Client({ name: "http-agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
  };
  return { client, call };
}
const owner = (url: string, path: string, init: RequestInit = {}, token: string | null = OWNER) =>
  fetch(`${url}${path}`, { ...init, headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });

describe("streamable HTTP transport", () => {
  it("serves MCP to an agent whose mandate is its bearer token", async () => {
    const { url } = await boot();
    const { client, call } = await agent(url, await mandateToken());
    expect((await client.listTools()).tools.length).toBeGreaterThan(40);
    const r = await call("create_refund", { capture_id: I.capture42, amount: { currency_code: "USD", value: "42.00" } });
    expect(r.isError).toBe(false);
    expect(r.body.status).toBe("COMPLETED");
  });

  it("rejects connections without a mandate, with a bad one, and with a different one mid-session", async () => {
    const { url } = await boot();
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(init) })).status).toBe(401);
    expect((await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, Authorization: "Bearer not-a-mandate" }, body: JSON.stringify(init) })).status).toBe(401);

    const good = await mandateToken();
    const ok = await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${good}` }, body: JSON.stringify(init) });
    expect(ok.status).toBe(200);
    const sid = ok.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    const other = await mandateToken({ ...SUPPORT_MANDATE, agentId: "someone-else" });
    const hijack = await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": sid, Authorization: `Bearer ${other}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    expect(hijack.status).toBe(401);
  });

  it("owner API: approve a held refund with POST /approvals/:id, then the agent polls the result", async () => {
    const { url, rt } = await boot();
    const { call } = await agent(url, await mandateToken());
    const held = await call("create_refund", { capture_id: I.capture100, amount: { currency_code: "USD", value: "70.00" } });
    expect(held.body.status).toBe("pending_approval");
    const id = held.body.approvalId as string;

    // owner authentication is required, and a wrong token is not accepted
    expect((await owner(url, `/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) }, null)).status).toBe(401);
    expect((await owner(url, `/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) }, "wrong-token-wrong-token")).status).toBe(401);
    expect(rt.fixtureExecutor!.calls.some((c) => c.method === "create_refund")).toBe(false);

    const list = (await (await owner(url, "/approvals?status=pending")).json()) as { approvals: any[] };
    expect(list.approvals.map((a: any) => a.approvalId)).toEqual([id]);
    expect(list.approvals[0]).toMatchObject({ tool: "create_refund", agentId: "support-agent" });

    const res = await owner(url, `/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "executed", result: { amount: { value: "70.00" } } });
    expect(rt.fixtureExecutor!.calls.filter((c) => c.method === "create_refund")).toHaveLength(1);

    const again = await owner(url, `/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    expect(again.status).toBe(409);
    expect((await call("payleash_check_approval", { approvalId: id })).body.status).toBe("executed");
  });

  it("owner API accepts {deny:true} and rejects malformed bodies and unknown ids", async () => {
    const { url } = await boot();
    const { call } = await agent(url, await mandateToken());
    const held = await call("create_refund", { capture_id: I.capture100, amount: { currency_code: "USD", value: "70.00" } });
    const id = held.body.approvalId as string;
    expect((await owner(url, `/approvals/${id}`, { method: "POST", body: JSON.stringify({ maybe: 1 }) })).status).toBe(400);
    expect((await owner(url, `/approvals/apr_nope`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status).toBe(404);
    const res = await owner(url, `/approvals/${id}`, { method: "POST", body: JSON.stringify({ deny: true }) });
    expect(await res.json()).toMatchObject({ status: "denied" });
  });

  it("kill switch over HTTP freezes and unfreezes writes", async () => {
    const { url } = await boot();
    const { call } = await agent(url, await mandateToken());
    const refund = { capture_id: I.capture42, amount: { currency_code: "USD", value: "5.00" } };
    expect((await owner(url, "/freeze", { method: "POST", body: JSON.stringify({ reason: "incident" }) }, null)).status).toBe(401);
    expect((await owner(url, "/freeze", { method: "POST", body: JSON.stringify({ reason: "incident" }) })).status).toBe(200);
    const frozen = await call("create_refund", refund);
    expect(frozen.isError).toBe(true);
    expect(frozen.body.reasons[0].code).toBe("frozen_global");
    expect((await owner(url, "/unfreeze", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await call("create_refund", refund)).isError).toBe(false);
  });

  it("GET /audit/verify reports the chain state", async () => {
    const { url } = await boot();
    const { call } = await agent(url, await mandateToken());
    await call("create_refund", { capture_id: I.capture42, amount: { currency_code: "USD", value: "5.00" } });
    const v = (await (await owner(url, "/audit/verify")).json()) as { ok: boolean };
    expect(v).toMatchObject({ ok: true, entries: 2 });
    expect((await owner(url, `/audit/verify?head=${"a".repeat(64)}`)).status).toBe(200);
    expect(((await (await owner(url, `/audit/verify?head=${"a".repeat(64)}`)).json()) as { ok: boolean }).ok).toBe(false);
  });

  it("the owner API is disabled (503) when no owner token is configured", async () => {
    const rt = makeRuntime({ PAYLEASH_OWNER_TOKEN: "" });
    running = await startHttp(rt, { host: "127.0.0.1", port: 0, mcp: true });
    expect((await owner(running.url, "/approvals")).status).toBe(503);
    expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
  });

  it("without MCP enabled (stdio mode) /mcp does not exist", async () => {
    const rt = makeRuntime();
    running = await startHttp(rt, { host: "127.0.0.1", port: 0, mcp: false });
    expect((await fetch(`${running.url}/mcp`, { method: "POST" })).status).toBe(404);
  });
});
