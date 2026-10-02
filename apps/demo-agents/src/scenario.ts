import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { EXAMPLE_SUPPORT_MANDATE, issueMandate, type MandateInput } from "@payleash/core";
import { startProxy, type RunningProxy } from "@payleash/proxy";
import type { LanguageModel } from "ai";
import { handleDispute, listOpenDisputes, type DisputeResult } from "./dispute-agent.js";
import { readInbox } from "./eml.js";
import { describeModel, languageModel, modelConfigFromEnv } from "./llm.js";
import { adaptEmailForLive, shopFromManifest } from "./live.js";
import { createLogger, type Logger } from "./log.js";
import { ProxyClient } from "./mcp.js";
import { ShopBook, demoWorld } from "./shop.js";
import { followUp, handleEmail, type SupportResult } from "./support-agent.js";

const here = fileURLToPath(new URL(".", import.meta.url));
export const APP_DIR = resolve(here, "..");
export const REPO_DIR = resolve(APP_DIR, "../..");

export const DISPUTE_MANDATE: MandateInput = {
  agentId: "dispute-agent",
  allowedTools: ["list_disputes", "get_dispute", "get_order", "get_shipment_tracking", "provide_dispute_evidence", "accept_dispute_claim"],
  constraints: {
    provide_dispute_evidence: { currency: "USD", maxAmountPerOp: "500.00" },
    accept_dispute_claim: { currency: "USD", maxAmountPerOp: "100.00" },
  },
};

export interface ScenarioOptions {
  /** An already running proxy (sandbox). Without it the demo proxy runs inside this process, on recorded PayPal data. */
  url?: string;
  port?: number;
  host?: string;
  ownerToken?: string;
  supportMandate?: string;
  disputeMandate?: string;
  /** Seed manifest (`pnpm seed`) that supplies real sandbox orders. Required with `url`. */
  manifest?: string;
  /** auto: the "owner" approves through the owner API. dashboard: wait for a human to approve in the dashboard. skip: leave held calls pending. */
  approve: "auto" | "dashboard" | "skip";
  /** Force the scripted agents even when a model is configured. */
  scripted: boolean;
  paceMs: number;
  inbox?: string;
  outDir?: string;
  keepOpen?: boolean;
  killSwitch?: boolean;
  only?: "support" | "dispute" | "all";
  maxDisputes?: number;
  dashboardDir?: string;
  dashboardWaitMs?: number;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  color?: boolean;
  /** Test hook: a model to use instead of the one from the environment. */
  model?: LanguageModel;
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioReport {
  mode: "demo" | "sandbox";
  agent: "scripted" | "model";
  support: SupportResult[];
  disputes: DisputeResult[];
  followUps: { approvalId: string; status: string }[];
  checks: Check[];
  /** True when every check passed (the checks are only expected to hold for the scripted agents on demo data). */
  ok: boolean;
  dashboardUrl?: string;
  ownerToken?: string;
}

class Owner {
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}
  async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.url}${path}`, { method, headers: { Authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* text */
    }
    if (!res.ok) throw new Error(`owner API ${method} ${path} -> ${res.status}: ${typeof json === "string" ? json.slice(0, 200) : json?.error ?? JSON.stringify(json).slice(0, 200)}`);
    return json;
  }
  pending(): Promise<{ approvals: { approvalId: string; tool: string; agentId: string; explanation: string }[] }> {
    return this.call("GET", "/approvals?status=pending");
  }
}

const EXPECTED: Record<string, { kind: string; code?: string }> = {
  "01-damaged-mug.eml": { kind: "executed" },
  "02-tote-bags-missing.eml": { kind: "held" },
  "03-sticker-pack.eml": { kind: "executed" },
  "04-polite-injection.eml": { kind: "denied", code: "payee_not_original_buyer" },
  "05-refund-still-missing.eml": { kind: "denied", code: "refund_exceeds_balance" },
  "06-shipping-charged-twice.eml": { kind: "executed" },
};

export async function runScenario(o: ScenarioOptions): Promise<ScenarioReport> {
  const env = o.env ?? process.env;
  const log: Logger = createLogger({ out: o.out, color: o.color, paceMs: o.paceMs });
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    log("result", `${pass ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  };
  const outDir = o.outDir ?? resolve(APP_DIR, "out");
  const only = o.only ?? "all";

  // ---- the model, if any ------------------------------------------------------------------------------
  const cfg = o.scripted ? null : modelConfigFromEnv(env);
  const model = o.model ?? (cfg ? languageModel(cfg) : undefined);
  const agentKind = model ? "model" : "scripted";

  // ---- the proxy -------------------------------------------------------------------------------------------
  let running: RunningProxy | undefined;
  let url = o.url?.replace(/\/+$/, "");
  const mode: "demo" | "sandbox" = url ? "sandbox" : "demo";
  let ownerToken = o.ownerToken ?? env.PAYLEASH_OWNER_TOKEN?.trim();
  let supportMandate = o.supportMandate ?? env.PAYLEASH_MANDATE?.trim();
  let disputeMandate = o.disputeMandate ?? env.PAYLEASH_MANDATE_DISPUTE?.trim();
  let book: ShopBook;

  log.section(mode === "demo" ? "PayLeash demo agents · recorded PayPal, no keys needed" : `PayLeash demo agents · PayPal SANDBOX through ${url}`);
  log("proxy", model ? `agents: language model (${describeModel(cfg ?? { provider: "custom", baseURL: "http://test.invalid", apiKey: "", model: "test model" })})` : "agents: scripted and deterministic (no language model configured: set CF_ACCOUNT_ID + CF_API_TOKEN for the free Cloudflare Workers AI tier)");

  if (!url) {
    ownerToken = ownerToken || randomBytes(18).toString("hex");
    const dashboardDir = o.dashboardDir ?? (existsSync(resolve(REPO_DIR, "apps/dashboard/dist/index.html")) ? resolve(REPO_DIR, "apps/dashboard/dist") : undefined);
    running = await startProxy(
      { transport: "http", host: o.host ?? "127.0.0.1", port: o.port ?? 8787, fixtures: true, allowLive: false, demo: true, demoActivity: false, dashboardDir },
      { ...env, PAYLEASH_OWNER_TOKEN: ownerToken, PAYLEASH_DEMO_TOKEN: env.PAYLEASH_DEMO_TOKEN ?? "judge-demo-2026", PAYLEASH_DEMO_SHOW: "1", PAYLEASH_QUIET: "1" },
      { log: () => {} },
    );
    const rt = running.runtime;
    url = running.http!.url;
    const recorded = {
      history: JSON.parse(readFileSync(resolve(REPO_DIR, "scripts/seed-sandbox/fixtures/backtest-history.json"), "utf8")),
      disputes: JSON.parse(readFileSync(resolve(REPO_DIR, "scripts/seed-sandbox/fixtures/disputes.json"), "utf8")),
    };
    const world = demoWorld(rt.now(), recorded);
    Object.assign(rt.fixtureExecutor!.responses, world.responses);
    book = world.book;
    const sign = async (input: MandateInput) => {
      const { token, mandate } = await issueMandate(rt.ownerPrivateKey!, input, { issuer: "payleash-demo", ttlSeconds: 7 * 86400, now: rt.now() });
      rt.mandates.record(mandate, "issued", rt.now().getTime());
      return token;
    };
    supportMandate = await sign(EXAMPLE_SUPPORT_MANDATE);
    disputeMandate = await sign(DISPUTE_MANDATE);
    log("proxy", `PayLeash proxy and dashboard are up at ${url}  (PayPal is simulated: nothing can leave this machine)`);
    log("proxy", `dashboard sign-in token (this run only): ${ownerToken}`);
  } else {
    if (!ownerToken || !supportMandate) throw new Error("with --url you must set PAYLEASH_OWNER_TOKEN and PAYLEASH_MANDATE (the support agent's mandate)");
    if (!o.manifest) throw new Error("with --url, pass --manifest <seed manifest.json> so the inbox orders map to real sandbox orders (run `pnpm seed` first)");
    const live = shopFromManifest(o.manifest);
    if (live.problems.length) throw new Error(`the sandbox orders do not fit the inbox:\n  ${live.problems.join("\n  ")}`);
    book = live.book;
    log("proxy", `using the PayLeash proxy at ${url} and ${live.book.orders.length} sandbox orders from ${o.manifest}`);
  }
  const owner = new Owner(url, ownerToken!);
  const dashboardUrl = running ? url : undefined;

  const support = await ProxyClient.connect(url, supportMandate!, "support-agent");
  const dispute = disputeMandate && only !== "support" ? await ProxyClient.connect(url, disputeMandate, "dispute-agent") : undefined;

  const decide = async (label: string, ids: Set<string>): Promise<void> => {
    if (!ids.size) return;
    if (o.approve === "skip") return log("owner", `${ids.size} call(s) stay pending (--approve skip)`);
    if (o.approve === "dashboard") {
      log("owner", `⏳ ${ids.size} held call(s) wait for YOU. ${dashboardUrl ? `Open ${dashboardUrl}/approvals, sign in with the token above,` : "Open your dashboard's Approvals page"} and tap Approve.`);
      const stop = Date.now() + (o.dashboardWaitMs ?? 20 * 60_000);
      while (Date.now() < stop) {
        const p = await owner.pending();
        const left = p.approvals.filter((a) => ids.has(a.approvalId)).length;
        if (!left) return void log("owner", "all decided");
        await new Promise((r) => setTimeout(r, 1000));
      }
      return void log("warn", "timed out waiting for the dashboard; going on");
    }
    log("owner", `📱 ${label}: reviewing ${ids.size} held call(s) (this is the dashboard's Approve button, pressed through the owner API)`);
    const p = await owner.pending();
    for (const a of p.approvals.filter((x) => ids.has(x.approvalId))) {
      await log.beat();
      const r = await owner.call("POST", `/approvals/${a.approvalId}`, { decision: "approve", note: "demo run" });
      log("owner", `   ✔ approved ${a.approvalId} (${a.tool}) → ${r.status}${r.error ? `: ${r.error}` : ""}`);
    }
  };

  const supportResults: SupportResult[] = [];
  const disputeResults: DisputeResult[] = [];
  let followUps: { approvalId: string; status: string }[] = [];

  try {
    // ---- 1. the support / refund agent ----------------------------------------------------------------------
    if (only !== "dispute") {
      const inbox = readInbox(o.inbox ?? resolve(APP_DIR, "inbox"));
      log.section(`Support agent · ${inbox.length} customer emails`);
      const deps = { proxy: support, book, log, repliesDir: resolve(outDir, "replies"), model };
      for (const email of inbox) supportResults.push(await handleEmail(deps, mode === "sandbox" ? adaptEmailForLive(email, book) : email));

      log.section("Owner · approvals");
      await decide("owner", new Set(supportResults.flatMap((r) => (r.outcome.kind === "held" ? [r.outcome.approvalId] : []))));
      followUps = await followUp(deps, supportResults);
    }

    // ---- 2. the dispute agent -----------------------------------------------------------------------------------
    if (dispute) {
      log.section("Dispute agent · evidence for open disputes");
      const ids = (await listOpenDisputes(dispute)).slice(0, o.maxDisputes ?? 50);
      log("dispute", ids.length ? `${ids.length} open dispute(s): ${ids.join(", ")}` : "no open disputes. In the sandbox, open one by hand from a buyer account (see apps/demo-agents/README.md).");
      for (const id of ids) disputeResults.push(await handleDispute({ proxy: dispute, book, log, outDir: resolve(outDir, "disputes"), model }, id));
      log.section("Owner · approvals");
      await decide("owner", new Set(disputeResults.flatMap((r) => (r.outcome.kind === "held" ? [r.outcome.approvalId] : []))));
      for (const r of disputeResults) {
        if (r.outcome.kind !== "held") continue;
        const view = await owner.call("GET", "/approvals");
        const a = view.approvals.find((x: { approvalId: string }) => x.approvalId === (r.outcome as { approvalId: string }).approvalId);
        followUps.push({ approvalId: (r.outcome as { approvalId: string }).approvalId, status: a?.status ?? "unknown" });
        log("dispute", `   ${r.disputeId}: evidence approval ${a?.status ?? "unknown"}`);
      }
    }

    // ---- 3. the kill switch ---------------------------------------------------------------------------------------
    let frozenCode: string | undefined;
    if (o.killSwitch !== false && supportResults.length) {
      log.section("Kill switch");
      await log.beat();
      log("owner", "🧊 FREEZE: the owner hits the kill switch");
      await owner.call("POST", "/freeze", { reason: "demo: something looks wrong" });
      const probe = supportResults.find((r) => r.outcome.kind === "executed");
      if (probe) {
        const shop = book.byNumber(probe.orderNumber ?? "");
        log("support", `→ create_refund 1.00 on ${shop?.captureId} (the agent keeps trying)`);
        const r = await support.call("create_refund", { capture_id: shop?.captureId, amount: { currency_code: "USD", value: "1.00" } });
        const codes = (r.body?.reasons ?? []).map((x: { code: string }) => x.code);
        frozenCode = codes[0];
        log("support", `   🛑 DENIED [${codes.join(", ")}]: ${r.body?.explanation ?? ""}`);
      }
      await owner.call("POST", "/unfreeze", {});
      log("owner", "☀  unfrozen");
    }

    // ---- 4. the audit chain ---------------------------------------------------------------------------------------
    log.section("Audit");
    const audit = await owner.call("GET", "/audit/verify");
    log("result", `audit hash chain: ${audit.ok ? `VERIFIED ✓  ${audit.entries} entries, head #${audit.headSeq}` : `TAMPERED ✗ ${JSON.stringify(audit.problems).slice(0, 200)}`}`);

    // ---- 5. checks ---------------------------------------------------------------------------------------------------
    log.section("Result");
    const expectHold = mode === "demo" && agentKind === "scripted";
    if (expectHold) {
      for (const r of supportResults) {
        const want = EXPECTED[r.email.file];
        if (!want) continue;
        const got = r.outcome.kind;
        const codeOk = !want.code || (r.outcome.kind === "denied" && r.outcome.codes.includes(want.code));
        check(r.email.file, got === want.kind && codeOk, `${got}${r.outcome.kind === "denied" ? ` [${r.outcome.codes.join(", ")}]` : ""}${want.code ? ` (expected ${want.kind} with ${want.code})` : ` (expected ${want.kind})`}`);
      }
      if (supportResults.length) {
        const held = supportResults.find((r) => r.email.file === "02-tote-bags-missing.eml");
        const fu = followUps.find((f) => held?.outcome.kind === "held" && f.approvalId === held.outcome.approvalId);
        if (o.approve === "auto") check("held $60 refund executed after approval", fu?.status === "executed", fu?.status ?? "no follow-up");
      }
      if (dispute) {
        check("disputes: evidence held for the owner, none sent behind its back", disputeResults.length > 0 && disputeResults.every((r) => r.outcome.kind === "held"), disputeResults.map((r) => `${r.disputeId}:${r.outcome.kind}`).join(", "));
        if (o.approve === "auto") check("approved evidence reached PayPal", disputeResults.every((r) => followUps.find((f) => r.outcome.kind === "held" && f.approvalId === r.outcome.approvalId)?.status === "executed"), "all approvals executed");
      }
      if (o.killSwitch !== false && supportResults.length) check("kill switch denies writes", frozenCode === "frozen_global", String(frozenCode));
      check("audit chain verifies", audit.ok === true, `${audit.entries} entries`);
    } else {
      const n = (k: string) => supportResults.filter((r) => r.outcome.kind === k).length;
      log("result", `support: ${n("executed")} ran, ${n("held")} held, ${n("denied")} denied · disputes: ${disputeResults.filter((r) => r.outcome.kind === "held").length} held for approval`);
      check("audit chain verifies", audit.ok === true, `${audit.entries} entries`);
    }
    const fails = checks.filter((c) => !c.pass).length;
    log("result", fails ? `${fails} check(s) FAILED` : `${checks.length} checks passed`);
    log("proxy", `drafts: ${resolve(outDir, "replies")}  and  ${resolve(outDir, "disputes")}`);

    if (o.keepOpen && running) {
      log("proxy", `still running at ${url}. Press Ctrl+C to stop.`);
      await new Promise<void>((res) => {
        process.once("SIGINT", () => res());
        process.once("SIGTERM", () => res());
      });
    }
    return { mode, agent: agentKind, support: supportResults, disputes: disputeResults, followUps, checks, ok: checks.every((c) => c.pass), dashboardUrl, ownerToken: running ? ownerToken : undefined };
  } finally {
    await support.close();
    await dispute?.close();
    await running?.close();
  }
}
