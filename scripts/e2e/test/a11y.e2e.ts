import { AxeBuilder } from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningProxy } from "@payleash/proxy";
import { launch } from "../src/browser.js";
import { DEMO, PAGES, signIn, startDemo } from "../src/harness.js";

let proxy: RunningProxy;
let browser: Browser;
let base: string;
beforeAll(async () => {
  proxy = await startDemo();
  base = proxy.http!.url;
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await proxy?.close();
});

async function violations(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 4).map((n) => n.target.join(" ") + " :: " + (n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 160)).join("\n    ")}`);
}

const SCHEMES = [
  { name: "light", colorScheme: "light" as const },
  { name: "dark", colorScheme: "dark" as const },
];

for (const scheme of SCHEMES) {
  for (const viewport of [{ name: "desktop", width: 1280, height: 860 }, { name: "phone 375", width: 375, height: 760 }]) {
    describe(`axe: ${scheme.name}, ${viewport.name}`, () => {
      let ctx: BrowserContext;
      let page: Page;
      beforeAll(async () => {
        ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme.colorScheme, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
        page = await ctx.newPage();
      });
      afterAll(() => ctx?.close());

      it("login page has no violations", async () => {
        await page.goto(base);
        await page.getByLabel("Owner token").waitFor();
        expect(await violations(page)).toEqual([]);
      });

      it("login page after a wrong token has no violations (error shown)", async () => {
        await page.getByLabel("Owner token").fill("wrong-token-wrong-token");
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByRole("alert").waitFor();
        expect(await violations(page)).toEqual([]);
      });

      it("every page has no violations", async () => {
        await signIn(page, base, DEMO);
        for (const p of PAGES) {
          await page.goto(`${base}${p.path}`);
          await p.ready(page);
          await page.waitForTimeout(300);
          expect(await violations(page), `${p.name} (${p.path})`).toEqual([]);
        }
      });
    });
  }
}

describe("axe: states", () => {
  let ctx: BrowserContext;
  let page: Page;
  beforeAll(async () => {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    page = await ctx.newPage();
    await signIn(page, base);
  });
  afterAll(() => ctx?.close());

  it("backtest results, the what-if slider and the attack cases", async () => {
    await page.goto(`${base}/backtest`);
    await page.getByRole("button", { name: /Run the backtest/ }).click();
    await page.getByText("Injection and attack cases").waitFor();
    await page.locator(".ag-row").first().waitFor();
    await page.getByRole("slider", { name: "Auto-approve limit" }).fill("50");
    await page.waitForTimeout(600);
    expect(await violations(page)).toEqual([]);
  });

  it("policy draft side by side", async () => {
    await page.goto(`${base}/policies`);
    await page.getByLabel("What may the agent do?").fill("Support agent may refund up to $100 per order, at most $300 a day, automatically up to $25; only orders from the last 60 days");
    await page.getByRole("button", { name: "Draft the mandate" }).click();
    await page.getByRole("heading", { name: "2. Check what changes" }).waitFor();
    expect(await violations(page)).toEqual([]);
  });

  it("audit row detail", async () => {
    await page.goto(`${base}/audit`);
    await page.locator(".ag-row").first().click();
    await page.waitForTimeout(300);
    expect(await violations(page)).toEqual([]);
  });

  it("kill switch: the confirmation dialog, then the frozen banner", async () => {
    await page.goto(base);
    await page.getByText("Live activity").waitFor();
    await page.getByRole("button", { name: /Kill switch: freeze all agents/ }).click();
    const dialog = page.getByRole("dialog", { name: "Freeze all agents?" });
    await dialog.waitFor();
    expect(await violations(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Freeze all agents" }).click();
    await page.getByText(/Kill switch is ON/).waitFor();
    await page.getByText("Kill switch ON: every agent is frozen.").waitFor(); // the toast
    expect(await violations(page)).toEqual([]);
    await page.getByRole("button", { name: "Lift the kill switch" }).click();
    await page.getByRole("button", { name: /Kill switch: freeze all agents/ }).waitFor();
  });

  it("approvals with nothing waiting (empty state)", async () => {
    await page.goto(`${base}/approvals`);
    await page.getByRole("button", { name: /Approve/ }).first().waitFor();
    for (let i = 0; i < 12; i++) {
      const b = page.getByRole("button", { name: /^Deny/ }).first();
      if (!(await b.count())) break;
      await b.click();
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(500);
    expect(await violations(page)).toEqual([]);
  });
});
