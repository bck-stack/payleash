import { parseArgs } from "node:util";

export interface ProxyOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
  /** Serve recorded PayPal fixtures instead of calling the sandbox (no credentials needed). */
  fixtures: boolean;
  allowLive: boolean;
  /** Public demo: recorded PayPal, throw-away keys and database, seeded activity, a read-only judge login. Implies `fixtures`. */
  demo?: boolean;
  /** Directory with the built dashboard (apps/dashboard/dist). Served at / next to the owner API. */
  dashboardDir?: string;
}

export const USAGE = `payleash-proxy [options]

  --transport stdio|http   MCP transport (default: stdio)
  --port N                 HTTP port for /mcp, the owner API and the dashboard (default: $PORT, else 8787)
  --host H                 bind address (default: 127.0.0.1)
  --fixtures               use recorded PayPal fixtures instead of the sandbox (demo / no credentials)
  --demo                   public demo: fixtures + throw-away keys and database + seeded activity + read-only demo login
                           (PAYLEASH_DEMO_TOKEN). Needs no credentials.
  --dashboard DIR          serve the built dashboard from DIR (default: PAYLEASH_DASHBOARD_DIR)
  --i-know-this-is-live    allow a PayPal base URL that is not the sandbox. PayLeash is sandbox-only; do not use.
  --help

Environment: see .env.example (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL, PAYLEASH_KEY_DIR,
PAYLEASH_DB_PATH, PAYLEASH_OWNER_TOKEN, PAYLEASH_MANDATE / PAYLEASH_MANDATE_FILE, CF_ACCOUNT_ID, CF_API_TOKEN).
`;

export function parseProxyArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ProxyOptions & { help: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      transport: { type: "string", default: "stdio" },
      port: { type: "string", default: env.PORT?.trim() || "8787" },
      host: { type: "string", default: "127.0.0.1" },
      fixtures: { type: "boolean", default: false },
      demo: { type: "boolean", default: false },
      dashboard: { type: "string" },
      "i-know-this-is-live": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.transport !== "stdio" && values.transport !== "http") throw new Error(`--transport must be stdio or http (got "${values.transport}")`);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port "${values.port}"`);
  return {
    transport: values.transport,
    host: values.host!,
    port,
    fixtures: values.fixtures! || values.demo!,
    allowLive: values["i-know-this-is-live"]!,
    demo: values.demo!,
    dashboardDir: values.dashboard ?? (env.PAYLEASH_DASHBOARD_DIR?.trim() || undefined),
    help: values.help!,
  };
}
