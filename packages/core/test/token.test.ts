import { describe, expect, it } from "vitest";
import { PayPalHttp, refreshAccessToken, runCli, type CliIo } from "../src/index.js";

/** A fake PayPal OAuth server: one cached token until it is terminated, then a new one with the app's current scopes. */
function fakePayPal(scopesAfter: string[], opts: { terminateStatus?: number; terminateWorks?: boolean } = {}) {
  const calls: { path: string; body: string; auth: string | null }[] = [];
  let issued = 0;
  let current: { token: string; scope: string } | undefined;
  const scopesBefore = ["https://uri.paypal.com/services/payments/refund"];
  const f = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: String(init.body), auth: new Headers(init.headers).get("authorization") });
    if (path === "/v1/oauth2/token") {
      if (!current) {
        issued++;
        current = { token: `tok-${issued}`, scope: (issued === 1 ? scopesBefore : scopesAfter).join(" ") };
      }
      return new Response(JSON.stringify({ access_token: current.token, expires_in: 32400, scope: current.scope, app_id: "APP-1" }), { status: 200 });
    }
    if (path === "/v1/oauth2/token/terminate") {
      const status = opts.terminateStatus ?? 200;
      if (status < 300 && opts.terminateWorks !== false) current = undefined;
      return new Response(status < 300 ? "" : JSON.stringify({ error: "nope" }), { status });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const creds = { clientId: "id", clientSecret: "secret" };

describe("refreshAccessToken", () => {
  it("terminates the cached token and picks up the scopes PayPal grants now", async () => {
    const fake = fakePayPal(["https://uri.paypal.com/services/payments/refund", "https://uri.paypal.com/services/reporting/search"]);
    const r = await refreshAccessToken(new PayPalHttp({ ...creds, fetch: fake.f }));
    expect(r.replaced).toBe(true);
    expect(r.terminated.ok).toBe(true);
    expect(r.scopesAdded).toEqual(["https://uri.paypal.com/services/reporting/search"]);
    const terminate = fake.calls.find((c) => c.path.endsWith("/terminate"))!;
    expect(terminate.body).toBe("token=tok-1&token_type_hint=ACCESS_TOKEN");
    expect(terminate.auth).toMatch(/^Basic /);
  });

  it("reports when PayPal hands the same token back", async () => {
    const fake = fakePayPal([], { terminateWorks: false });
    const r = await refreshAccessToken(new PayPalHttp({ ...creds, fetch: fake.f }));
    expect(r.replaced).toBe(false);
  });
});

describe("payleash paypal refresh-token", () => {
  const run = async (env: NodeJS.ProcessEnv, f?: typeof fetch) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (s) => out.push(s), err: (s) => err.push(s), env, fetch: f };
    return { code: await runCli(["paypal", "refresh-token"], io), out: out.join("\n"), err: err.join("\n") };
  };

  it("prints the new scopes and exits 0", async () => {
    const fake = fakePayPal(["https://uri.paypal.com/services/payments/refund", "https://uri.paypal.com/services/reporting/search"]);
    const r = await run({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s" }, fake.f);
    expect(r.code).toBe(0);
    expect(r.out).toContain("reporting/search   <- new");
  });

  it("exits 1 with a pointer to the troubleshooting doc when the token is not replaced", async () => {
    const r = await run({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s" }, fakePayPal([], { terminateStatus: 400 }).f);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/SMOKE-TEST/);
  });

  it("needs credentials and refuses a non-sandbox host", async () => {
    expect((await run({})).err).toMatch(/PAYPAL_CLIENT_ID/);
    expect((await run({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_BASE_URL: "https://api-m.paypal.com" })).err).toMatch(/sandbox/i);
  });
});
