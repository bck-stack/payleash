#!/usr/bin/env node
// Uptime self-check for a hosted PayLeash demo. No dependencies.
//
//   node scripts/uptime/check.mjs https://payleash-demo.onrender.com
//   DEMO_URL=https://payleash-demo.onrender.com pnpm demo:check
//
// Checks, in order: /healthz is healthy, the page is served, /api/me says it is a demo with the read-only login on,
// and the PayPal-facing mode is "fixtures". Retries for a while because a free Render service takes ~30 s to wake up
// (the first request is what wakes it). Exit code 0 = healthy, 1 = not.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function check(base, { fetchImpl = fetch, timeoutMs = 60_000, attempts = 4, waitMs = 15_000, log = () => {} } = {}) {
  const url = base.replace(/\/+$/, "");
  const get = async (path) => {
    const t0 = Date.now();
    const res = await fetchImpl(`${url}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: path === "/" ? "text/html" : "application/json" } });
    return { res, ms: Date.now() - t0, text: await res.text() };
  };
  const steps = [];
  const step = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
    return ok;
  };

  let lastError = "";
  for (let i = 1; i <= attempts; i++) {
    steps.length = 0;
    try {
      const h = await get("/healthz");
      const hj = JSON.parse(h.text);
      if (!step("healthz", h.res.status === 200 && hj.ok === true, `HTTP ${h.res.status} in ${h.ms} ms, uptime ${hj.uptimeSeconds ?? "?"} s, ${hj.pending ?? "?"} held calls, next reset ${hj.reset?.next ?? "n/a"}`)) throw new Error("unhealthy");
      const page = await get("/");
      step("dashboard page", page.res.status === 200 && /<title>PayLeash<\/title>/.test(page.text), `HTTP ${page.res.status} in ${page.ms} ms`);
      const me = await get("/api/me");
      const mj = JSON.parse(me.text);
      step("demo mode", me.res.status === 200 && mj.demo === true && mj.mode === "fixtures", `mode=${mj.mode}, demo=${mj.demo}`);
      step("read-only login offered", mj.demoLoginAvailable === true && typeof mj.demoPasscode === "string", mj.demoPasscode ? "passcode shown on the login page" : "no passcode shown");
      step("PayPal not reachable", mj.mode === "fixtures", "the server runs on recorded data");
      return { ok: steps.every((s) => s.ok), steps, attempts: i };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      log(`attempt ${i}/${attempts} failed: ${lastError}${i < attempts ? ` (retrying in ${waitMs / 1000} s: a sleeping free service needs ~30 s)` : ""}`);
      if (i < attempts) await sleep(waitMs);
    }
  }
  return { ok: false, steps, attempts, error: lastError };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? process.env.DEMO_URL;
  if (!target) {
    console.error("usage: node scripts/uptime/check.mjs <https://your-demo.onrender.com>   (or set DEMO_URL)");
    process.exit(2);
  }
  const r = await check(target, { log: (l) => console.log(l) });
  console.log(r.ok ? `HEALTHY: ${target}` : `UNHEALTHY: ${target}${r.error ? ` (${r.error})` : ""}`);
  process.exit(r.ok ? 0 : 1);
}
