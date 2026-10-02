import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";

/** Chromium from PLAYWRIGHT_BROWSERS_PATH (pre-installed on the CI image and in the Playwright docker image) or a system Chrome. */
export async function launch(): Promise<Browser> {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit) return chromium.launch({ executablePath: explicit });
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(base)) {
    const direct = join(base, "chromium", "chrome-linux", "chrome");
    if (existsSync(direct)) return chromium.launch({ executablePath: direct });
    for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-"))) {
      const p = join(base, d, "chrome-linux", "chrome");
      if (existsSync(p)) return chromium.launch({ executablePath: p });
    }
  }
  return chromium.launch(); // falls back to a browser installed with `npx playwright install chromium`
}
