import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@payleash/core": src("./packages/core/src/index.ts"),
      "@payleash/proxy": src("./packages/proxy/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/*/test/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
