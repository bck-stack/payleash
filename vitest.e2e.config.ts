import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Browser tests: need Chromium and the built dashboard. `pnpm test:e2e`. Not part of `pnpm test`.
export default defineConfig({
  resolve: { alias: { "@payleash/core": src("./packages/core/src/index.ts"), "@payleash/proxy": src("./packages/proxy/src/index.ts") } },
  test: { include: ["scripts/e2e/test/**/*.e2e.ts"], testTimeout: 90_000, hookTimeout: 90_000, fileParallelism: false },
});
