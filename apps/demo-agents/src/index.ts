import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runScenario } from "./scenario.js";

const USAGE = `demo-agents: a support agent and a dispute agent that really transact through the PayLeash proxy

  pnpm demo:agents                 recorded PayPal, no keys, nothing to configure (the proxy and dashboard run inside this command)
  pnpm demo:agents -- --approve dashboard      stop at the held calls and approve them yourself in the dashboard
  pnpm demo:agents -- --url http://127.0.0.1:8787 --manifest scripts/seed-sandbox/seed-output/manifest.json    the PayPal sandbox

  --approve auto|dashboard|skip   who approves the held calls (default auto: the owner API, simulated)
  --scripted                      scripted agents even if a model is configured (CF_ACCOUNT_ID + CF_API_TOKEN, or LLM_BASE_URL + LLM_API_KEY)
  --pace MS                       pause between steps for screen recording (default 500; --fast = 0)
  --only support|dispute|all      default all
  --max-disputes N                handle at most N disputes
  --no-killswitch                 skip the kill switch step
  --keep-open                     keep the proxy and dashboard running afterwards (Ctrl+C to stop)
  --port N / --host H             where the demo proxy listens (default 127.0.0.1:8787)
  --url U --manifest FILE         use a running proxy and real sandbox orders. Env: PAYLEASH_OWNER_TOKEN, PAYLEASH_MANDATE (support), PAYLEASH_MANDATE_DISPUTE
  --inbox DIR / --out DIR         emails to read (default apps/demo-agents/inbox) / where drafts are written (default apps/demo-agents/out)
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = (s) => console.log(s)): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((a, i) => !(a === "--" && i === argv.indexOf("--"))),
    options: {
      approve: { type: "string", default: "auto" },
      scripted: { type: "boolean", default: false },
      pace: { type: "string" },
      fast: { type: "boolean", default: false },
      only: { type: "string", default: "all" },
      "max-disputes": { type: "string" },
      "no-killswitch": { type: "boolean", default: false },
      "keep-open": { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" },
      url: { type: "string" },
      manifest: { type: "string" },
      inbox: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return out(USAGE), 0;
  if (!["auto", "dashboard", "skip"].includes(values.approve!)) throw new Error("--approve must be auto, dashboard or skip");
  if (!["support", "dispute", "all"].includes(values.only!)) throw new Error("--only must be support, dispute or all");
  const report = await runScenario({
    url: values.url,
    manifest: values.manifest,
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    approve: values.approve as "auto" | "dashboard" | "skip",
    scripted: values.scripted!,
    paceMs: values.fast ? 0 : values.pace !== undefined ? Number(values.pace) : 500,
    only: values.only as "support" | "dispute" | "all",
    maxDisputes: values["max-disputes"] ? Number(values["max-disputes"]) : undefined,
    killSwitch: !values["no-killswitch"],
    keepOpen: values["keep-open"],
    inbox: values.inbox ? resolve(values.inbox) : undefined,
    outDir: values.out ? resolve(values.out) : undefined,
    env,
    out,
  });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`demo-agents failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}
