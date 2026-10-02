import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProxyOptions } from "./config.js";
import { startHttp, type RunningHttp } from "./http.js";
import { buildProxy, stdioMandateToken, type ProxyOverrides, type ProxyRuntime } from "./runtime.js";
import { createMcpServer } from "./server.js";

export interface RunningProxy {
  runtime: ProxyRuntime;
  http?: RunningHttp;
  close(): Promise<void>;
}

/**
 * Starts the proxy. Over HTTP the agent connects to /mcp with its mandate as bearer token.
 * Over stdio the mandate comes from the environment, and the owner API still runs on HTTP when
 * PAYLEASH_OWNER_TOKEN is set (so held calls can be approved).
 */
export async function startProxy(opts: ProxyOptions, env: NodeJS.ProcessEnv = process.env, overrides: ProxyOverrides = {}): Promise<RunningProxy> {
  const rt = buildProxy(opts, env, overrides);
  const log = overrides.log ?? ((line: string) => process.stderr.write(`[payleash] ${line}\n`));
  let http: RunningHttp | undefined;

  try {
    if (opts.transport === "http") {
      http = await startHttp(rt, { host: opts.host, port: opts.port, mcp: true });
      log(`MCP (streamable HTTP) at ${http.url}/mcp, ${rt.tools.length} PayPal tools, mode=${rt.mode}`);
      if (!rt.ownerToken) log("owner API disabled: set PAYLEASH_OWNER_TOKEN to approve held calls over HTTP");
    } else {
      const session = await rt.app.openSession(stdioMandateToken(env));
      if (rt.ownerToken) {
        http = await startHttp(rt, { host: opts.host, port: opts.port, mcp: false });
        log(`owner API at ${http.url} (approvals, kill switch)`);
      } else {
        log("owner API disabled: set PAYLEASH_OWNER_TOKEN to approve held calls over HTTP");
      }
      await createMcpServer({ app: rt.app, session, tools: rt.tools }).connect(new StdioServerTransport());
      log(`MCP over stdio for agent "${session.mandate.agentId}", ${rt.tools.length} PayPal tools, mode=${rt.mode}`);
    }
  } catch (e) {
    await http?.close();
    rt.close();
    throw e;
  }

  return {
    runtime: rt,
    http,
    close: async () => {
      await http?.close();
      rt.close();
    },
  };
}
