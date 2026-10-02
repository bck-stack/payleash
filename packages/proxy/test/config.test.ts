import { generateKeyPairSync } from "node:crypto";
import { LiveEndpointError, openDb } from "@payleash/core";
import { describe, expect, it } from "vitest";
import { buildProxy, parseProxyArgs, startProxy, stdioMandateToken } from "../src/index.js";
import { keys, makeRuntime } from "./helpers.js";

const base = { transport: "http", host: "127.0.0.1", port: 0, fixtures: true, allowLive: false } as const;
const quiet = { db: openDb(":memory:"), keys, log: () => {} };

describe("sandbox guard", () => {
  it.each(["https://api-m.paypal.com", "https://api.paypal.com", "https://evil.example.com", "https://api-m.sandbox.paypal.com.evil.com"])(
    "refuses to start against %s",
    (url) => {
      expect(() => buildProxy(base, { PAYPAL_BASE_URL: url }, quiet)).toThrow(LiveEndpointError);
      expect(() => buildProxy(base, { PAYPAL_BASE_URL: url }, quiet)).toThrow(/i-know-this-is-live/);
    },
  );

  it("starts against the sandbox hosts (default and explicit) and local mocks", () => {
    for (const env of [{}, { PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com" }, { PAYPAL_BASE_URL: "http://localhost:9999" }]) {
      const rt = buildProxy(base, env, { ...quiet, db: openDb(":memory:") });
      expect(rt.tools.length).toBeGreaterThan(40);
    }
  });

  it("starts against a live URL only with --i-know-this-is-live, and warns loudly", () => {
    const lines: string[] = [];
    const rt = buildProxy({ ...base, allowLive: true }, { PAYPAL_BASE_URL: "https://api-m.paypal.com", PAYPAL_CLIENT_ID: "x", PAYPAL_CLIENT_SECRET: "y" }, { ...quiet, db: openDb(":memory:"), log: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/NON-SANDBOX/);
    expect(rt.baseUrl).toBe("https://api-m.paypal.com");
  });

  it("startProxy propagates the refusal (nothing is left listening)", async () => {
    await expect(startProxy(base, { PAYPAL_BASE_URL: "https://api-m.paypal.com" }, { ...quiet, db: openDb(":memory:") })).rejects.toThrow(LiveEndpointError);
  });
});

describe("configuration errors are explicit", () => {
  it("needs sandbox credentials unless --fixtures", () => {
    expect(() => buildProxy({ ...base, fixtures: false }, {}, { ...quiet, db: openDb(":memory:") })).toThrow(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  });
  it("rejects a short owner token", () => {
    expect(() => buildProxy(base, { PAYLEASH_OWNER_TOKEN: "short" }, { ...quiet, db: openDb(":memory:") })).toThrow(/at least 16/);
  });
  it("tells you where it looked for keys", () => {
    expect(() => buildProxy(base, { PAYLEASH_KEY_DIR: "/nonexistent/keys" }, { db: openDb(":memory:"), log: () => {} })).toThrow(/payleash keys init/);
  });
  it("stdio needs a mandate", () => {
    expect(() => stdioMandateToken({})).toThrow(/PAYLEASH_MANDATE/);
    expect(stdioMandateToken({ PAYLEASH_MANDATE: " abc " })).toBe("abc");
  });
  it("parses CLI flags", () => {
    expect(parseProxyArgs([])).toMatchObject({ transport: "stdio", port: 8787, fixtures: false, allowLive: false });
    expect(parseProxyArgs(["--transport", "http", "--port", "9000", "--fixtures", "--i-know-this-is-live"])).toMatchObject({ transport: "http", port: 9000, fixtures: true, allowLive: true });
    expect(() => parseProxyArgs(["--transport", "carrier-pigeon"])).toThrow();
    expect(() => parseProxyArgs(["--port", "99999"])).toThrow();
  });
  it("two runtimes do not share state", () => {
    expect(makeRuntime().db).not.toBe(makeRuntime().db);
    expect(generateKeyPairSync("ed25519")).toBeTruthy();
  });
});
