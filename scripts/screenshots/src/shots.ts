import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import { launch } from "./browser.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const outDir = `${root}docs/screenshots`;
const PORT = Number(process.env.SHOT_PORT ?? 8799);
const OWNER = "screenshot-owner-token-0123456789";
const DEMO = "judge-demo-2026";
const base = `http://127.0.0.1:${PORT}`;

mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, ["packages/proxy/dist/bin.js", "--transport", "http", "--demo", "--port", String(PORT), "--dashboard", "apps/dashboard/dist"], {
  cwd: root,
  env: { ...process.env, PAYLEASH_OWNER_TOKEN: OWNER, PAYLEASH_DEMO_TOKEN: DEMO, PAYLEASH_DEMO_SHOW: "1", PAYLEASH_QUIET: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});
const stop = () => server.kill("SIGTERM");
process.on("exit", stop);

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the proxy did not start");
}

async function signIn(page: Page, token: string) {
  await page.goto(base);
  await page.getByLabel("Owner token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: /Overview/ }).first().waitFor();
}

await waitUp();
const browser = await launch();
try {
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const page = await desktop.newPage();

  // login page (with the opt-in public demo passcode)
  await page.goto(base);
  await page.getByLabel("Owner token").waitFor();
  await page.screenshot({ path: `${outDir}/login.png` });

  await signIn(page, OWNER);
  await page.getByText("Live activity").waitFor();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/overview.png` });

  await page.goto(`${base}/policies`);
  await page.getByLabel("What may the agent do?").fill("Support agent may refund up to $100 per order, at most $300 a day, automatically up to $25; only orders from the last 60 days");
  await page.getByRole("button", { name: "Draft the mandate" }).click();
  await page.getByRole("heading", { name: "2. Check what changes" }).waitFor();
  await page.getByRole("heading", { name: "Side by side" }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/policies.png`, fullPage: true });

  await page.goto(`${base}/audit`);
  await page.getByText(/Chain verified/).waitFor();
  await page.locator(".ag-row").first().waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/audit.png` });

  await page.goto(`${base}/backtest`);
  await page.getByRole("button", { name: /Run the backtest/ }).click();
  await page.getByText("Injection and attack cases").waitFor();
  await page.locator(".ag-row").first().waitFor();
  await page.getByRole("slider", { name: "Auto-approve limit" }).fill("50");
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/backtest.png`, fullPage: true });

  // mobile: one-tap approvals
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const m = await phone.newPage();
  await signIn(m, OWNER);
  await m.goto(`${base}/approvals`);
  await m.getByRole("button", { name: /Approve/ }).first().waitFor();
  await m.waitForTimeout(400);
  await m.screenshot({ path: `${outDir}/approvals-mobile.png` });
  await desktop.close();
  await phone.close();
  console.log(`screenshots written to docs/screenshots`);
} finally {
  await browser.close();
  stop();
}
