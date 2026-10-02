import { randomUUID, type KeyObject } from "node:crypto";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { callHash } from "../canonical.js";
import { MandateError } from "./errors.js";
import { MandateInputSchema, MandateSchema, type Mandate, type MandateInput } from "./schema.js";

const MANDATE_TYP = "payleash-mandate+jwt";
const STEPUP_TYP = "payleash-stepup+jwt";
const ALG = "EdDSA";

const nowSec = (now?: Date) => Math.floor((now ?? new Date()).getTime() / 1000);

async function verifyJws(token: string, key: KeyObject, typ: string, now?: Date) {
  try {
    const { payload } = await jwtVerify(token.trim(), key, {
      algorithms: [ALG],
      typ,
      currentDate: now ?? new Date(),
      clockTolerance: 0,
    });
    return payload;
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw new MandateError("expired", "mandate has expired");
    if (e instanceof joseErrors.JWTClaimValidationFailed) {
      if (e.claim === "nbf") throw new MandateError("not_yet_valid", "mandate is not valid yet");
      if (e.claim === "exp") throw new MandateError("expired", "mandate has expired");
      throw new MandateError("wrong_type", `claim check failed: ${e.claim}`);
    }
    if (e instanceof joseErrors.JWSSignatureVerificationFailed) throw new MandateError("bad_signature", "signature verification failed");
    if (e instanceof joseErrors.JOSEAlgNotAllowed) throw new MandateError("bad_signature", "algorithm not allowed");
    throw new MandateError("malformed", e instanceof Error ? e.message : "malformed token");
  }
}

// ---------------------------------------------------------------------------
// Operation mandates (signed by the owner key)
// ---------------------------------------------------------------------------

export interface IssueMandateOptions {
  issuer: string;
  /** Seconds the mandate is valid for. */
  ttlSeconds: number;
  id?: string;
  now?: Date;
  /** Seconds to subtract from `nbf` for clock skew. Default 0. */
  notBeforeSkewSeconds?: number;
}

export async function issueMandate(
  ownerPrivateKey: KeyObject,
  input: MandateInput,
  opts: IssueMandateOptions,
): Promise<{ token: string; mandate: Mandate }> {
  const parsed = MandateInputSchema.parse(input);
  const iat = nowSec(opts.now);
  const mandate = MandateSchema.parse({
    ...parsed,
    id: opts.id ?? `mnd_${randomUUID()}`,
    issuer: opts.issuer,
    notBefore: iat - (opts.notBeforeSkewSeconds ?? 0),
    expiresAt: iat + opts.ttlSeconds,
  });
  const token = await new SignJWT({
    payleash: { v: 1, allowed_tools: mandate.allowedTools, constraints: mandate.constraints },
  })
    .setProtectedHeader({ alg: ALG, typ: MANDATE_TYP })
    .setIssuer(mandate.issuer)
    .setSubject(mandate.agentId)
    .setJti(mandate.id)
    .setIssuedAt(iat)
    .setNotBefore(mandate.notBefore)
    .setExpirationTime(mandate.expiresAt)
    .sign(ownerPrivateKey);
  return { token, mandate };
}

export async function verifyMandate(token: string, ownerPublicKey: KeyObject, opts: { now?: Date } = {}): Promise<Mandate> {
  const p = await verifyJws(token, ownerPublicKey, MANDATE_TYP, opts.now);
  const body = p.payleash as { allowed_tools?: unknown; constraints?: unknown } | undefined;
  const parsed = MandateSchema.safeParse({
    id: p.jti,
    issuer: p.iss,
    agentId: p.sub,
    notBefore: p.nbf,
    expiresAt: p.exp,
    allowedTools: body?.allowed_tools,
    constraints: body?.constraints ?? {},
  });
  if (!parsed.success) throw new MandateError("invalid_claims", parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Step-up mandates: single use, bound to one held call, minted on owner approval
// ---------------------------------------------------------------------------

export const STEP_UP_DEFAULT_TTL_SECONDS = 60;

export interface StepUpClaims {
  id: string;
  issuer: string;
  agentId: string;
  tool: string;
  /** SHA-256 over tool name + canonical args. */
  callHash: string;
  approvalId: string;
  /** The operation mandate that was in force when the call was held. */
  parentMandateId: string;
  issuedAt: number;
  expiresAt: number;
}

/** Remembers consumed step-up ids. Implemented over SQLite in `db`; in-memory below for tests. */
export interface ReplayGuard {
  /** Returns true the first time an id is seen, false afterwards. Must be atomic. */
  consume(id: string, expiresAt: number): boolean;
}

export class MemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Set<string>();
  consume(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}

export interface MintStepUpInput {
  agentId: string;
  tool: string;
  args: unknown;
  approvalId: string;
  parentMandateId: string;
}

export async function mintStepUp(
  stepUpPrivateKey: KeyObject,
  input: MintStepUpInput,
  opts: { issuer: string; ttlSeconds?: number; now?: Date; id?: string } = { issuer: "payleash-proxy" },
): Promise<{ token: string; claims: StepUpClaims }> {
  const iat = nowSec(opts.now);
  const claims: StepUpClaims = {
    id: opts.id ?? `stp_${randomUUID()}`,
    issuer: opts.issuer,
    agentId: input.agentId,
    tool: input.tool,
    callHash: callHash(input.tool, input.args),
    approvalId: input.approvalId,
    parentMandateId: input.parentMandateId,
    issuedAt: iat,
    expiresAt: iat + (opts.ttlSeconds ?? STEP_UP_DEFAULT_TTL_SECONDS),
  };
  const token = await new SignJWT({
    payleash: { v: 1, tool: claims.tool, call_hash: claims.callHash, approval_id: claims.approvalId, parent: claims.parentMandateId },
  })
    .setProtectedHeader({ alg: ALG, typ: STEPUP_TYP })
    .setIssuer(claims.issuer)
    .setSubject(claims.agentId)
    .setJti(claims.id)
    .setIssuedAt(iat)
    .setExpirationTime(claims.expiresAt)
    .sign(stepUpPrivateKey);
  return { token, claims };
}

export interface VerifyStepUpInput {
  agentId: string;
  tool: string;
  args: unknown;
}

/**
 * Verifies signature, expiry, that the token is bound to exactly this call, and consumes it.
 * Consumption is the last step, so a mismatching call does not burn a valid token.
 */
export async function verifyStepUp(
  token: string,
  stepUpPublicKey: KeyObject,
  call: VerifyStepUpInput,
  replay: ReplayGuard,
  opts: { now?: Date } = {},
): Promise<StepUpClaims> {
  const p = await verifyJws(token, stepUpPublicKey, STEPUP_TYP, opts.now);
  const body = p.payleash as { tool?: string; call_hash?: string; approval_id?: string; parent?: string } | undefined;
  if (!p.jti || !p.sub || !p.iss || !p.exp || !p.iat || !body?.tool || !body.call_hash || !body.approval_id || !body.parent) {
    throw new MandateError("invalid_claims", "step-up mandate is missing claims");
  }
  if (p.sub !== call.agentId) throw new MandateError("agent_mismatch", "step-up mandate was issued for a different agent");
  if (body.tool !== call.tool || body.call_hash !== callHash(call.tool, call.args)) {
    throw new MandateError("call_mismatch", "step-up mandate is bound to a different call");
  }
  if (!replay.consume(p.jti, p.exp)) throw new MandateError("replayed", "step-up mandate was already used");
  return {
    id: p.jti,
    issuer: p.iss,
    agentId: p.sub,
    tool: body.tool,
    callHash: body.call_hash,
    approvalId: body.approval_id,
    parentMandateId: body.parent,
    issuedAt: p.iat,
    expiresAt: p.exp,
  };
}
