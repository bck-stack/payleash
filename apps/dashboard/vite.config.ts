import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the dashboard talks to a proxy started with `pnpm proxy --transport http --demo` on :8787.
const PROXY = process.env.PAYLEASH_PROXY_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200 },
  server: { port: 5173, proxy: { "/api": PROXY, "/healthz": PROXY } },
});
