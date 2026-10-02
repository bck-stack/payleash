import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultKeyDir, initKeys, loadPrivateKey, loadPublicKey } from "./keys.js";
import { issueMandate, verifyMandate } from "./mandate/index.js";

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
}

export const defaultIo: CliIo = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  env: process.env,
};

const USAGE = `payleash <command>

  keys init [--dir D] [--force] [--allow-in-repo]   generate the owner + step-up Ed25519 keys (outside the repo)
  mandate issue --file F [--ttl 30d] [--issuer NAME] [--key-dir D]
                                                   sign an operation mandate; prints the token
  mandate verify (--token T | --file F) [--key-dir D]
                                                   verify a mandate and print its claims
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
    options: { file: { type: "string" }, ttl: { type: "string" }, issuer: { type: "string" }, "key-dir": { type: "string" } },
  });
  if (!values.file) throw new Error("--file is required");
  const input = JSON.parse(readFileSync(values.file, "utf8"));
  const dir = values["key-dir"] ?? defaultKeyDir(io.env);
  const { token, mandate } = await issueMandate(loadPrivateKey(dir, "owner"), input, {
    issuer: values.issuer ?? "payleash-owner",
    ttlSeconds: parseTtl(values.ttl ?? input.ttl ?? "30d"),
  });
  io.err(`mandate ${mandate.id} for agent "${mandate.agentId}" valid until ${new Date(mandate.expiresAt * 1000).toISOString()}`);
  io.out(token);
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

/** Returns the process exit code. */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [a, b, ...rest] = argv;
  const cmd = commands.get(`${a} ${b}`);
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
