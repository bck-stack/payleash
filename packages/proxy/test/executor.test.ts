import { PayPalHttp } from "@payleash/core";
import { describe, expect, it, vi } from "vitest";

const constructed: { token: string; ctx: any }[] = [];
const run = vi.fn();
vi.mock("@paypal/agent-toolkit/mcp", () => ({
  PayPalAPI: class {
    constructor(token: string, ctx: any) {
      constructed.push({ token, ctx });
    }
    run = run;
  },
  PayPalMCPToolkit: class {},
}));

const { ToolkitExecutor, interpretResult } = await import("../src/executor.js");

function http(now: { t: number }) {
  let n = 0;
  const fetchImpl = (async () => new Response(JSON.stringify({ access_token: `tok-${++n}`, expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
  return new PayPalHttp({ clientId: "id", clientSecret: "secret", fetch: fetchImpl, now: () => now.t });
}

describe("ToolkitExecutor", () => {
  it("runs the toolkit with the sandbox flag, reuses the token, and refreshes it before expiry", async () => {
    const now = { t: 1_000_000 };
    const ex = new ToolkitExecutor(http(now), true);
    run.mockResolvedValue('{"id":"REF1"}');
    expect(await ex.run("create_refund", { capture_id: "C" })).toBe('{"id":"REF1"}');
    await ex.run("get_order", { id: "O" });
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({ token: "tok-1", ctx: { sandbox: true } });
    expect(run).toHaveBeenLastCalledWith("get_order", { id: "O" });
    now.t += 3_600_000; // token expired
    await ex.run("get_order", { id: "O" });
    expect(constructed).toHaveLength(2);
    expect(constructed[1]!.token).toBe("tok-2");
  });

  it("turns an empty toolkit response into an explicit success", async () => {
    run.mockResolvedValue(undefined);
    expect(await new ToolkitExecutor(http({ t: 0 }), true).run("cancel_subscription", {})).toBe('{"ok":true}');
  });
});

describe("interpretResult recognises every failure shape of the toolkit", () => {
  it.each([
    ['LlmError (HTTP error)', '{"ok":false,"status":422,"code":"PAYPAL_API_HTTP_ERROR","message":"The refund amount must be less than or equal to the capture amount"}', "The refund amount"],
    ["thrown error", '{"error":{"message":"Failed to fetch access token","type":"paypal_error"}}', "Failed to fetch"],
    ["raw PayPal error body", '{"name":"RESOURCE_NOT_FOUND","message":"Specified resource does not exist","debug_id":"abc"}', "RESOURCE_NOT_FOUND"],
  ])("%s -> not ok", (_n, text, fragment) => {
    const r = interpretResult(text);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(fragment);
  });

  it("extracts the PayPal result id of a success and tolerates non-JSON", () => {
    expect(interpretResult('{"id":"3AB12345","status":"COMPLETED"}')).toMatchObject({ ok: true, resultId: "3AB12345" });
    expect(interpretResult('{"ok":true}')).toMatchObject({ ok: true, resultId: undefined });
    expect(interpretResult("plain text")).toEqual({ ok: true });
  });
});
