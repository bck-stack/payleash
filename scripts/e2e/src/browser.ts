import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";

/** Chromium from CHROMIUM_PATH, PLAYWRIGHT_BROWSERS_PATH (the CI image, the Playwright docker image) or one installed with `playwright-core install chromium`. */
export async function launch(args: string[] = []): Promise<Browser> {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit) return chromium.launch({ executablePath: explicit, args });
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(base)) {
    const direct = join(base, "chromium", "chrome-linux", "chrome");
    if (existsSync(direct)) return chromium.launch({ executablePath: direct, args });
    for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-"))) {
      const p = join(base, d, "chrome-linux", "chrome");
      if (existsSync(p)) return chromium.launch({ executablePath: p, args });
    }
  }
  return chromium.launch({ args });
}
