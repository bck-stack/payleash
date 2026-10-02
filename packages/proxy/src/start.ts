import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProxyOptions } from "./config.js";
import { startHttp, type RunningHttp } from "./http.js";
import { buildProxy, demoOwnerTokenFallback, stdioMandateToken, type ProxyOverrides, type ProxyRuntime } from "./runtime.js";
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
  const log = overrides.log ?? ((line: string) => process.stderr.write(`[payleash] ${line}\n`));
  if (opts.demo && !env.PAYLEASH_OWNER_TOKEN?.trim()) {
    // A local `--demo` needs no setup: a random owner token, printed once.
    env = { ...env, PAYLEASH_OWNER_TOKEN: demoOwnerTokenFallback(env) };
    log(`demo owner token (random, this run only): ${env.PAYLEASH_OWNER_TOKEN}`);
  }
  const rt = buildProxy(opts, env, overrides);
  let http: RunningHttp | undefined;

  try {
    if (rt.demo) {
      await rt.demo.reseed({ activity: opts.demoActivity !== false });
      log(`DEMO MODE: recorded PayPal, throw-away keys, in-memory database. ${rt.approvals.countPending()} held calls are waiting in the dashboard.${rt.demoToken ? " A read-only demo login is enabled (PAYLEASH_DEMO_TOKEN)." : ""}`);
    }
    if (opts.transport === "http") {
      http = await startHttp(rt, { host: opts.host, port: opts.port, mcp: true, dashboardDir: opts.dashboardDir });
      log(`MCP (streamable HTTP) at ${http.url}/mcp, ${rt.tools.length} PayPal tools, mode=${rt.mode}`);
      if (!rt.ownerToken) log("owner API disabled: set PAYLEASH_OWNER_TOKEN to approve held calls over HTTP");
    } else {
      const session = await rt.app.openSession(stdioMandateToken(env));
      if (rt.ownerToken) {
        http = await startHttp(rt, { host: opts.host, port: opts.port, mcp: false, dashboardDir: opts.dashboardDir });
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
