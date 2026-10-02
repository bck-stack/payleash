/// <reference lib="dom" />
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningProxy } from "@payleash/proxy";
import { launch } from "../src/browser.js";
import { OWNER, PAGES, signIn, startDemo } from "../src/harness.js";

// The approval flow on a phone: 375 px wide, touch, owner login.
let proxy: RunningProxy;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let base: string;
beforeAll(async () => {
  proxy = await startDemo();
  base = proxy.http!.url;
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 375, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page = await ctx.newPage();
});
afterAll(async () => {
  await ctx?.close();
  await browser?.close();
  await proxy?.close();
});

const noHorizontalScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

describe("mobile approval flow at 375 px", () => {
  it("every page fits the screen without sideways scrolling", async () => {
    await signIn(page, base, OWNER);
    for (const p of PAGES) {
      await page.goto(`${base}${p.path}`);
      await p.ready(page);
      expect(await noHorizontalScroll(page), `${p.name} scrolls sideways`).toBe(true);
    }
  });

  it("the approve and deny buttons are big enough to tap (44 px) and visible without scrolling the page sideways", async () => {
    await page.goto(`${base}/approvals`);
    await page.getByRole("button", { name: /Approve/ }).first().waitFor();
    for (const name of [/^Approve/, /^Deny/]) {
      const box = await page.getByRole("button", { name }).first().boundingBox();
      expect(box, String(name)).not.toBeNull();
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    }
  });

  it("tap Approve: the call runs, a confirmation appears, the badge counts down, the card shows the result", async () => {
    await page.goto(`${base}/approvals`);
    const card = page.locator("article.approval").first();
    await card.waitFor();
    const before = await proxy.runtime.approvals.countPending();
    expect(before).toBeGreaterThan(1);
    const summary = (await card.locator(".summary").first().innerText()).trim();
    await card.getByRole("button", { name: /^Approve/ }).tap();
    await page.getByRole("status").filter({ hasText: /Approved and executed/ }).waitFor();
    // the executed call leaves the "Waiting" list and appears under "Decided"
    await page.getByRole("tab", { name: /Decided/ }).tap();
    await page.locator("article.approval").filter({ hasText: summary.slice(0, 40) }).getByText("Executed").waitFor();
    expect(summary.length).toBeGreaterThan(10);
    expect(proxy.runtime.approvals.countPending()).toBe(before - 1);
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(proxy.runtime.audit.verify().ok).toBe(true);
    // the nav badge follows
    await page.waitForFunction((n) => document.querySelector(".nav .dot")?.textContent === String(n), before - 1, { timeout: 15_000 });
  });

  it("tap Deny: the agent is told no and nothing executes", async () => {
    await page.goto(`${base}/approvals`);
    const card = page.locator("article.approval").first();
    await card.getByRole("button", { name: /^Deny/ }).waitFor();
    const callsBefore = proxy.runtime.fixtureExecutor!.calls.length;
    await card.getByRole("button", { name: /^Deny/ }).tap();
    await page.getByRole("status").filter({ hasText: /Denied/ }).waitFor();
    expect(proxy.runtime.fixtureExecutor!.calls.length).toBe(callsBefore);
  });

  it("an error from the server shows as a toast, not a blank screen", async () => {
    await page.goto(`${base}/approvals`);
    const card = page.locator("article.approval").first();
    await card.getByRole("button", { name: /^Approve/ }).waitFor();
    await page.route("**/api/approvals/*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal error" }) }));
    await card.getByRole("button", { name: /^Approve/ }).tap();
    await page.getByRole("alert").filter({ hasText: /internal error/ }).first().waitFor();
    await page.unroute("**/api/approvals/*");
  });

  it("the kill switch needs a confirmation on a phone too", async () => {
    await page.goto(base);
    await page.getByRole("button", { name: /Kill switch: freeze all agents/ }).tap();
    const dialog = page.getByRole("dialog", { name: "Freeze all agents?" });
    await dialog.waitFor();
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
    await dialog.getByRole("button", { name: "Cancel" }).tap();
    await dialog.waitFor({ state: "hidden" });
    expect(proxy.runtime.policy.freezeState("support-agent").frozen).toBe(false);
  });
});
