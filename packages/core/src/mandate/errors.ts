export type MandateErrorCode =
  | "malformed"
  | "bad_signature"
  | "not_yet_valid"
  | "expired"
  | "wrong_type"
  | "invalid_claims"
  | "call_mismatch"
  | "agent_mismatch"
  | "replayed";

export class MandateError extends Error {
  constructor(
    readonly code: MandateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MandateError";
  }
}
