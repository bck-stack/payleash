import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LiveEndpointError, PayPalHttp, SANDBOX_BASE_URL, assertSandboxBaseUrl } from "@payleash/core";
import { buildDisputeFixtures, buildHistory } from "./history.js";
import { DEFAULT_BUYERS, INVOICES, PRODUCTS, planOrders, planRefunds } from "./plan.js";
import { runSeed, type OrderMode } from "./seed.js";
import { StateFile, type SeedState } from "./state.js";

export interface Io {
  out: (s: string) => void;
  env: NodeJS.ProcessEnv;
}

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `seed-sandbox: create PayPal SANDBOX demo data (idempotent: safe to re-run)

  pnpm seed                         create products, orders, partial refunds, invoices; list disputes
  pnpm seed -- --dry-run            print the plan, call nothing
  pnpm seed -- --history            (re)generate fixtures/backtest-history.json and fixtures/disputes.json (offline)

  --count N          orders to create (default 200)
  --mode M           auto | card | paypal (default auto: try test cards, else PayPal-wallet orders you approve by hand)
  --paypal-orders N  cap for wallet-mode orders, which need a human to approve each (default 10)
  --state-dir D      resume files (default scripts/seed-sandbox/.seed-state)
  --out-dir D        manifest output (default scripts/seed-sandbox/seed-output)

Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (sandbox REST app), PAYPAL_BASE_URL (optional, sandbox only),
     SEED_BUYER_EMAILS (optional, comma separated personas used in the plan)
`;

const MISSING_CREDS = `PayPal sandbox credentials are not set, so nothing was created (this is not an error).

  1. developer.paypal.com -> Apps & Credentials -> Sandbox -> create (or open) an app
  2. export PAYPAL_CLIENT_ID=<sandbox client id>
     export PAYPAL_CLIENT_SECRET=<sandbox secret>
  3. pnpm seed

Without credentials you can still use the offline data: pnpm seed -- --history
`;

export async function main(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    // `pnpm seed -- --history` forwards the literal "--"; parseArgs would treat everything after it as positionals.
    args: argv.filter((a, i) => !(a === "--" && i === argv.indexOf("--"))),
    options: {
      "dry-run": { type: "boolean", default: false },
      history: { type: "boolean", default: false },
      count: { type: "string", default: "200" },
      mode: { type: "string", default: "auto" },
      "paypal-orders": { type: "string", default: "10" },
      "state-dir": { type: "string" },
      "out-dir": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (!["auto", "card", "paypal"].includes(values.mode!)) throw new Error(`--mode must be auto, card or paypal`);
  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("--count must be between 1 and 1000");
  const buyers = io.env.SEED_BUYER_EMAILS ? io.env.SEED_BUYER_EMAILS.split(",").map((s) => s.trim()).filter(Boolean) : [...DEFAULT_BUYERS];

  if (values.history) {
    const dir = join(pkgDir, "fixtures");
    mkdirSync(dir, { recursive: true });
    const history = buildHistory();
    writeFileSync(join(dir, "backtest-history.json"), JSON.stringify(history, null, 1) + "\n");
    writeFileSync(join(dir, "disputes.json"), JSON.stringify(buildDisputeFixtures(history), null, 1) + "\n");
    io.out(`wrote ${history.orders.length} orders over ${history.meta.days} days (${history.orders.filter((o) => o.refunds).length} with partial refunds) and 3 disputes to ${dir}`);
    return 0;
  }

  if (values["dry-run"]) {
    const plan = planOrders(count, buyers);
    io.out(`products (${PRODUCTS.length}): ${PRODUCTS.map((p) => `${p.sku} ${p.price}`).join(", ")}`);
    io.out(`orders: ${plan.length}, e.g. ${plan.slice(0, 3).map((o) => `${o.key} ${o.buyer} ${o.total} USD`).join("; ")}`);
    io.out(`partial refunds: ${planRefunds(plan).map((r) => `${r.orderKey} -${r.value}`).join(", ")}`);
    io.out(`invoices (${INVOICES.length}): ${INVOICES.map((i) => `${i.number} ${i.amount} -> ${i.recipient}${i.send ? " (sent)" : ""}`).join(", ")}`);
    io.out("disputes: cannot be created through the sandbox API (see README); fixtures/disputes.json is provided");
    return 0;
  }

  const clientId = io.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = io.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    io.out(MISSING_CREDS);
    return 0; // deliberately 0: CI must not fail just because the secrets are absent
  }

  const baseUrl = io.env.PAYPAL_BASE_URL?.trim() || SANDBOX_BASE_URL;
  try {
    assertSandboxBaseUrl(baseUrl); // the seed script never accepts a live URL, there is no override flag
  } catch (e) {
    if (e instanceof LiveEndpointError) {
      io.out(`${e.message.replace(/ If you really.*$/, "")} The seed script has no live override.`);
      return 3;
    }
    throw e;
  }

  const stateFile = new StateFile(resolve(values["state-dir"] ?? join(pkgDir, ".seed-state")));
  const state = stateFile.load();
  const api = new PayPalHttp({ baseUrl, clientId, clientSecret });
  io.out(`Seeding ${baseUrl} (sandbox). Resumable: state in ${stateFile.path}`);
  await runSeed(api, state, {
    count,
    mode: values.mode as OrderMode,
    paypalOrders: Number(values["paypal-orders"]),
    buyers,
    save: (s) => stateFile.save(s),
    log: io.out,
  });

  const outDir = resolve(values["out-dir"] ?? join(pkgDir, "seed-output"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest(state, baseUrl), null, 2));
  io.out(`manifest: ${join(outDir, "manifest.json")}`);

  const waiting = Object.entries(state.orders).filter(([, o]) => o.stage === "awaiting_approval" && o.approveUrl);
  if (waiting.length) {
    io.out("");
    io.out(`MANUAL STEP: ${waiting.length} order(s) need a sandbox buyer to approve them. Open each link, log in with a sandbox PERSONAL account, approve:`);
    for (const [key, o] of waiting) io.out(`  ${key}: ${o.approveUrl}`);
    io.out("Then run `pnpm seed` again: approved orders are captured, refunds and the rest continue.");
  }
  io.out("");
  io.out("Note: PayPal cannot backdate sandbox orders, so all of them carry today's date. For the 90-day backtest use fixtures/backtest-history.json.");
  return 0;
}

function manifest(s: SeedState, baseUrl: string) {
  return {
    createdAt: new Date().toISOString(),
    baseUrl,
    products: s.products,
    orders: Object.entries(s.orders).map(([key, o]) => ({ key, ...o })),
    refunds: s.refunds,
    invoices: s.invoices,
    disputes: s.disputes,
    notes: s.notes,
  };
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { out: (s) => console.log(s), env: process.env }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
