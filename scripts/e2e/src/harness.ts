import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy, type RunningProxy } from "@payleash/proxy";
import type { Page } from "playwright-core";

export const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
export const OWNER = "e2e-owner-token-0123456789abcdef";
export const DEMO = "judge-demo-2026";

/** The real proxy in demo mode, serving the built dashboard (run `pnpm build:dashboard` first). */
export async function startDemo(): Promise<RunningProxy> {
  const dashboardDir = resolve(REPO, "apps/dashboard/dist");
  if (!existsSync(resolve(dashboardDir, "index.html"))) throw new Error("apps/dashboard/dist is missing: run `pnpm build:dashboard` first");
  return startProxy(
    { transport: "http", host: "127.0.0.1", port: 0, fixtures: true, allowLive: false, demo: true, dashboardDir },
    { PAYLEASH_OWNER_TOKEN: OWNER, PAYLEASH_DEMO_TOKEN: DEMO, PAYLEASH_DEMO_SHOW: "1", PAYLEASH_QUIET: "1" },
    { log: () => {} },
  );
}

export async function signIn(page: Page, base: string, token = OWNER): Promise<void> {
  await page.goto(base);
  await page.getByLabel("Owner token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: /Overview/ }).first().waitFor();
}

export const PAGES = [
  { path: "/", name: "Overview", ready: (p: Page) => p.getByText("Live activity").waitFor() },
  { path: "/approvals", name: "Approvals", ready: (p: Page) => p.getByRole("button", { name: /Approve/ }).first().waitFor() },
  { path: "/policies", name: "Policies", ready: (p: Page) => p.getByLabel("What may the agent do?").waitFor() },
  { path: "/audit", name: "Audit", ready: async (p: Page) => { await p.getByText(/Chain verified/).waitFor(); await p.locator(".ag-row").first().waitFor(); } },
  { path: "/backtest", name: "Backtest", ready: (p: Page) => p.getByRole("button", { name: /Run the backtest/ }).waitFor() },
] as const;
