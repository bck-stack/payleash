import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runSmoke } from "./smoke.js";

const USAGE = `smoke: end-to-end check of a running PayLeash proxy (HTTP transport)

  pnpm smoke -- --capture-small <captureId> --capture-large <captureId> [options]

  --capture-small ID   sandbox capture for the small refund (and the injection attempt)
  --capture-large ID   sandbox capture whose remaining balance is at least --large-amount (may equal --capture-small)
  --small-amount V     default 10.00 (must be at or below the mandate's autoApproveThreshold)
  --large-amount V     default 60.00 (above the threshold, at or below maxAmountPerOp)
  --currency C         default USD
  --no-approve         stop at pending_approval instead of approving through the owner API
  --url U              default http://127.0.0.1:8787 (or PAYLEASH_URL)

Env: PAYLEASH_MANDATE (the agent's mandate), PAYLEASH_OWNER_TOKEN (the proxy's owner token)
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((a, i) => !(a === "--" && i === argv.indexOf("--"))),
    options: {
      "capture-small": { type: "string" },
      "capture-large": { type: "string" },
      "small-amount": { type: "string" },
      "large-amount": { type: "string" },
      currency: { type: "string" },
      "no-approve": { type: "boolean", default: false },
      url: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return out(USAGE), 0;
  const mandate = env.PAYLEASH_MANDATE?.trim();
  const ownerToken = env.PAYLEASH_OWNER_TOKEN?.trim();
  if (!values["capture-small"] || !values["capture-large"] || !mandate || !ownerToken) {
    out(USAGE);
    out("Missing: " + [!values["capture-small"] && "--capture-small", !values["capture-large"] && "--capture-large", !mandate && "PAYLEASH_MANDATE", !ownerToken && "PAYLEASH_OWNER_TOKEN"].filter(Boolean).join(", "));
    return 2;
  }
  const result = await runSmoke({
    url: (values.url ?? env.PAYLEASH_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, ""),
    mandate,
    ownerToken,
    captureSmall: values["capture-small"],
    captureLarge: values["capture-large"],
    smallAmount: values["small-amount"],
    largeAmount: values["large-amount"],
    currency: values.currency,
    approve: !values["no-approve"],
    log: out,
  });
  out(result.ok ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env, (s) => console.log(s)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`smoke failed to run: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}
