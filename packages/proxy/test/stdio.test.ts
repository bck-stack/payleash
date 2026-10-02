import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initKeys, issueMandate, loadPrivateKey } from "@payleash/core";
import { describe, expect, it } from "vitest";
import { I, SUPPORT_MANDATE } from "./helpers.js";

const bin = resolve(__dirname, "../dist/bin.js");
const built = existsSync(bin) && existsSync(resolve(__dirname, "../../core/dist/index.js"));

// Runs the real compiled binary over stdio. Needs `pnpm build` first (CI does it).
describe.skipIf(!built)("stdio transport (compiled binary, fixture PayPal)", () => {
  it("serves MCP over stdio with the mandate from the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payleash-stdio-"));
    try {
      const keyDir = join(dir, "keys");
      initKeys({ dir: keyDir });
      const { token } = await issueMandate(loadPrivateKey(keyDir, "owner"), SUPPORT_MANDATE, { issuer: "owner", ttlSeconds: 3600 });
      const client = new Client({ name: "stdio-agent", version: "1" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [bin, "--fixtures"],
          env: { ...(process.env as Record<string, string>), PAYLEASH_KEY_DIR: keyDir, PAYLEASH_DB_PATH: join(dir, "p.db"), PAYLEASH_MANDATE: token, PAYLEASH_OWNER_TOKEN: "" },
          stderr: "ignore",
        }),
      );
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["create_refund", "payleash_status"]));

      const ok = await client.callTool({ name: "create_refund", arguments: { capture_id: I.capture42, amount: { currency_code: "USD", value: "42.00" } } });
      expect(JSON.parse((ok.content as { text: string }[])[0]!.text)).toMatchObject({ status: "COMPLETED" });
      const bad = await client.callTool({ name: "create_refund", arguments: { capture_id: I.capture100, amount: { currency_code: "USD", value: "999.00" }, payee_email: "attacker@example.com" } });
      expect(bad.isError).toBe(true);
      expect(JSON.parse((bad.content as { text: string }[])[0]!.text).status).toBe("denied");
      await client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
