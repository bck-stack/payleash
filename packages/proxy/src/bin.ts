#!/usr/bin/env node
import { LiveEndpointError } from "@payleash/core";
import { USAGE, parseProxyArgs } from "./config.js";
import { startProxy } from "./start.js";

try {
  const opts = parseProxyArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
  } else {
    const running = await startProxy(opts);
    const stop = () => void running.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
} catch (e) {
  process.stderr.write(`[payleash] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(e instanceof LiveEndpointError ? 3 : 2);
}
