import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  MandateError,
  MemoryReplayGuard,
  callHash,
  canonicalize,
  initKeys,
  issueMandate,
  loadPrivateKey,
  loadPublicKey,
  mintStepUp,
  money,
  parseDecimal,
  verifyMandate,
  verifyStepUp,
  type MandateInput,
} from "../src/index.js";

const ed = () => generateKeyPairSync("ed25519");
const T0 = new Date("2026-10-01T12:00:00Z");
const after = (s: number) => new Date(T0.getTime() + s * 1000);

const input: MandateInput = {
  agentId: "support-agent",
  allowedTools: ["create_refund", "get_order"],
  constraints: {
    create_refund: {
      currency: "USD",
      maxAmountPerOp: "100.00",
      dailyTotal: "300.00",
      autoApproveThreshold: "25.00",
      payeeMustBeOriginalBuyer: true,
      orderAgeDays: 60,
    },
  },
};

describe("canonical json + call hash", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalize({ b: 1, a: { d: [1, undefined], c: undefined } })).toBe('{"a":{"d":[1,null]},"b":1}');
    expect(callHash("t", { a: 1, b: 2 })).toBe(callHash("t", { b: 2, a: 1 }));
  });
  it("changes with tool name or any arg", () => {
    expect(callHash("t", { a: 1 })).not.toBe(callHash("u", { a: 1 }));
    expect(callHash("t", { a: 1 })).not.toBe(callHash("t", { a: 2 }));
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ a: NaN })).toThrow();
  });
});

describe("money", () => {
  it.each([
    ["42", "USD", 4200],
    ["42.5", "USD", 4250],
    ["0.07", "USD", 7],
    ["1000", "JPY", 1000],
  ])("parses %s %s", (v, c, minor) => expect(parseDecimal(v, c)).toBe(minor));
  it.each([["-1", "USD"], ["1.234", "USD"], ["1.5", "JPY"], ["1e3", "USD"], ["", "USD"], ["abc", "USD"]])("rejects %s %s", (v, c) =>
    expect(() => parseDecimal(v, c)).toThrow(),
  );
  it("money() normalises currency", () => expect(money("1.00", "usd")).toEqual({ currency: "USD", minor: 100 }));
});

describe("operation mandates", () => {
  it("round-trips through an Ed25519 JWS", async () => {
    const { privateKey, publicKey } = ed();
    const { token, mandate } = await issueMandate(privateKey, input, { issuer: "owner", ttlSeconds: 3600, now: T0 });
    expect(token.split(".")).toHaveLength(3);
    const header = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());
    expect(header).toMatchObject({ alg: "EdDSA", typ: "payleash-mandate+jwt" });
    const verified = await verifyMandate(token, publicKey, { now: after(10) });
    expect(verified).toEqual(mandate);
    expect(verified.agentId).toBe("support-agent");
    expect(verified.constraints.create_refund?.orderAgeDays).toBe(60);
  });

  it("rejects a token signed by another key", async () => {
    const a = ed();
    const b = ed();
    const { token } = await issueMandate(a.privateKey, input, { issuer: "o", ttlSeconds: 60, now: T0 });
    await expect(verifyMandate(token, b.publicKey, { now: T0 })).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("rejects a tampered payload", async () => {
    const { privateKey, publicKey } = ed();
    const { token } = await issueMandate(privateKey, input, { issuer: "o", ttlSeconds: 60, now: T0 });
    const [h, p, s] = token.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    payload.payleash.constraints.create_refund.maxAmountPerOp = "99999.00";
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    await expect(verifyMandate(forged, publicKey, { now: T0 })).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("enforces the nbf/exp validity window", async () => {
    const { privateKey, publicKey } = ed();
    const { token } = await issueMandate(privateKey, input, { issuer: "o", ttlSeconds: 60, now: T0 });
    await expect(verifyMandate(token, publicKey, { now: after(-5) })).rejects.toMatchObject({ code: "not_yet_valid" });
    await expect(verifyMandate(token, publicKey, { now: after(30) })).resolves.toBeTruthy();
    await expect(verifyMandate(token, publicKey, { now: after(61) })).rejects.toMatchObject({ code: "expired" });
  });

  it("rejects non-EdDSA and wrong-typ tokens", async () => {
    const { privateKey, publicKey } = ed();
    const wrongTyp = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", typ: "JWT" }).setExpirationTime("1h").sign(privateKey);
    await expect(verifyMandate(wrongTyp, publicKey)).rejects.toBeInstanceOf(MandateError);
    await expect(verifyMandate("garbage", publicKey)).rejects.toMatchObject({ code: "malformed" });
    const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256", typ: "payleash-mandate+jwt" }).sign(new Uint8Array(32));
    await expect(verifyMandate(hs, publicKey)).rejects.toBeInstanceOf(MandateError);
  });

  it.each([
    ["amount without currency", { create_refund: { maxAmountPerOp: "5.00" } }],
    ["threshold above max", { create_refund: { currency: "USD", maxAmountPerOp: "5.00", autoApproveThreshold: "6.00" } }],
    ["max above daily total", { create_refund: { currency: "USD", maxAmountPerOp: "50.00", dailyTotal: "10.00" } }],
    ["too many decimals", { create_refund: { currency: "USD", maxAmountPerOp: "5.001" } }],
    ["constraints for a tool that is not allowed", { cancel_subscription: { orderAgeDays: 3 } }],
    ["unknown constraint key", { create_refund: { currency: "USD", surprise: 1 } }],
  ])("refuses to issue an invalid mandate: %s", async (_name, constraints) => {
    const { privateKey } = ed();
    await expect(
      issueMandate(privateKey, { agentId: "a", allowedTools: ["create_refund"], constraints } as MandateInput, { issuer: "o", ttlSeconds: 60 }),
    ).rejects.toThrow();
  });
});

describe("step-up mandates", () => {
  const args = { capture_id: "CAPTURE1234567890", amount: { currency_code: "USD", value: "60.00" } };
  const base = { agentId: "support-agent", tool: "create_refund", args, approvalId: "apr_1", parentMandateId: "mnd_1" };

  it("is bound to one call, short lived, and single use", async () => {
    const { privateKey, publicKey } = ed();
    const replay = new MemoryReplayGuard();
    const { token, claims } = await mintStepUp(privateKey, base, { issuer: "proxy", now: T0 });
    expect(claims.expiresAt - claims.issuedAt).toBeLessThanOrEqual(120);
    expect(claims.callHash).toBe(callHash("create_refund", args));

    // key order of args does not matter
    const reordered = { amount: { value: "60.00", currency_code: "USD" }, capture_id: "CAPTURE1234567890" };
    const ok = await verifyStepUp(token, publicKey, { agentId: "support-agent", tool: "create_refund", args: reordered }, replay, { now: after(5) });
    expect(ok.approvalId).toBe("apr_1");
    await expect(
      verifyStepUp(token, publicKey, { agentId: "support-agent", tool: "create_refund", args }, replay, { now: after(6) }),
    ).rejects.toMatchObject({ code: "replayed" });
  });

  it("does not verify for a different amount, tool, or agent (and does not burn the token)", async () => {
    const { privateKey, publicKey } = ed();
    const replay = new MemoryReplayGuard();
    const { token } = await mintStepUp(privateKey, base, { issuer: "proxy", now: T0 });
    const other = { ...args, amount: { currency_code: "USD", value: "600.00" } };
    await expect(verifyStepUp(token, publicKey, { agentId: "support-agent", tool: "create_refund", args: other }, replay, { now: T0 })).rejects.toMatchObject({
      code: "call_mismatch",
    });
    await expect(verifyStepUp(token, publicKey, { agentId: "support-agent", tool: "pay_order", args }, replay, { now: T0 })).rejects.toMatchObject({
      code: "call_mismatch",
    });
    await expect(verifyStepUp(token, publicKey, { agentId: "evil-agent", tool: "create_refund", args }, replay, { now: T0 })).rejects.toMatchObject({
      code: "agent_mismatch",
    });
    await expect(verifyStepUp(token, publicKey, { agentId: "support-agent", tool: "create_refund", args }, replay, { now: T0 })).resolves.toBeTruthy();
  });

  it("expires", async () => {
    const { privateKey, publicKey } = ed();
    const { token } = await mintStepUp(privateKey, base, { issuer: "proxy", now: T0, ttlSeconds: 30 });
    await expect(
      verifyStepUp(token, publicKey, { agentId: "support-agent", tool: "create_refund", args }, new MemoryReplayGuard(), { now: after(31) }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("is not accepted as an operation mandate, and vice versa", async () => {
    const k = ed();
    const { token: stepUp } = await mintStepUp(k.privateKey, base, { issuer: "proxy", now: T0 });
    await expect(verifyMandate(stepUp, k.publicKey, { now: T0 })).rejects.toBeInstanceOf(MandateError);
    const { token: mandate } = await issueMandate(k.privateKey, input, { issuer: "o", ttlSeconds: 60, now: T0 });
    await expect(
      verifyStepUp(mandate, k.publicKey, { agentId: "support-agent", tool: "create_refund", args }, new MemoryReplayGuard(), { now: T0 }),
    ).rejects.toBeInstanceOf(MandateError);
  });
});

describe("key storage", () => {
  it("writes keys with private permissions and refuses repo directories and overwrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "payleash-keys-"));
    try {
      const res = initKeys({ dir: join(dir, "k") });
      expect(statSync(join(dir, "k", "owner.key.pem")).mode & 0o777).toBe(0o600);
      expect(res.files).toHaveLength(4);
      expect(() => initKeys({ dir: join(dir, "k") })).toThrow(/already exists/);
      expect(() => initKeys({ dir: join(dir, "k"), force: true })).not.toThrow();
      expect(loadPublicKey(join(dir, "k"), "owner").asymmetricKeyType).toBe("ed25519");
      expect(loadPrivateKey(join(dir, "k"), "stepup").type).toBe("private");
      // this repository's own checkout must be rejected
      expect(() => initKeys({ dir: join(process.cwd(), "keys-in-repo") })).toThrow(/git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
