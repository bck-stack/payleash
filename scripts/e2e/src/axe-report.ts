import { AxeBuilder } from "@axe-core/playwright";
import { launch } from "./browser.js";
import { DEMO, OWNER, PAGES, signIn, startDemo } from "./harness.js";

// Prints every axe violation on every page, light and dark, desktop and phone: `pnpm --filter @payleash/e2e axe`.
const proxy = await startDemo();
const base = proxy.http!.url;
const browser = await launch();
const seen = new Map<string, string[]>();
try {
  for (const scheme of ["light", "dark"] as const) {
    for (const [vw, vh] of [[1280, 860], [375, 760]]) {
      const ctx = await browser.newContext({ viewport: { width: vw!, height: vh! }, colorScheme: scheme });
      const page = await ctx.newPage();
      const scan = async (label: string) => {
        const r = await new AxeBuilder({ page }).analyze();
        for (const v of r.violations) {
          const key = `${v.id} [${v.impact}] ${v.help}`;
          const list = seen.get(key) ?? [];
          for (const n of v.nodes.slice(0, 3)) list.push(`${scheme}/${vw} ${label}: ${n.target.join(" ")} :: ${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
          seen.set(key, list);
        }
      };
      await page.goto(base);
      await page.getByLabel("Owner token").waitFor();
      await scan("login");
      await signIn(page, base, vw === 375 ? DEMO : OWNER);
      for (const p of PAGES) {
        await page.goto(`${base}${p.path}`);
        await p.ready(page);
        await page.waitForTimeout(300);
        await scan(p.name);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await proxy.close();
}
if (!seen.size) console.log("no violations");
for (const [k, list] of seen) {
  console.log(`\n${k}`);
  for (const l of [...new Set(list)].slice(0, 8)) console.log(`   ${l}`);
}
process.exit(seen.size ? 1 : 0);
