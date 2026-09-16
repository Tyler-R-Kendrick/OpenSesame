/**
 * The only failure type this package throws.
 */

export type SiopV2ErrorCode =
  | "algorithm_not_allowed"
  | "malformed_request"
  | "malformed_id_token"
  | "invalid_sub_jwk"
  | "subject_mismatch"
  | "audience_mismatch"
  | "nonce_mismatch"
  | "issuer_mismatch"
  | "signature_invalid"
  | "token_expired"
  | "token_not_fresh"
  | "limit_exceeded"
  | "not_supported";

export type SiopV2Checkpoint =
  | "request_parse"
  | "request_normalize"
  | "jose_header"
  | "sub_jwk"
  | "thumbprint"
  | "id_token_build"
  | "id_token_verify"
  | "issuer_profile"
  | "audience_binding"
  | "nonce_binding"
  | "validity"
  | "response_serialize"
  | "response_parse"
  | "limits";

const MESSAGES = {
  algorithm_not_allowed: "JOSE header algorithm is not permitted",
  malformed_request: "authentication request is not well formed",
  malformed_id_token: "Self-Issued ID Token is not well formed",
  invalid_sub_jwk: "sub_jwk is not an accepted public P-256 key",
  subject_mismatch: "sub is not the JWK thumbprint of sub_jwk",
  audience_mismatch: "ID Token audience does not match client_id",
  nonce_mismatch: "ID Token nonce does not match the authentication request",
  issuer_mismatch: "ID Token issuer does not match the Self-Issued profile",
  signature_invalid: "ID Token signature did not verify against sub_jwk",
  token_expired: "ID Token has expired",
  token_not_fresh:
    "ID Token issued-at is outside the accepted freshness window",
  limit_exceeded: "input exceeded a size or time limit",
  not_supported: "feature is not supported by this package",
} as const satisfies Record<SiopV2ErrorCode, string>;

export class SiopV2Error extends Error {
  readonly code: SiopV2ErrorCode;
  readonly checkpoint: SiopV2Checkpoint;

  constructor(code: SiopV2ErrorCode, checkpoint: SiopV2Checkpoint) {
    super(MESSAGES[code]);
    this.name = "SiopV2Error";
    this.code = code;
    this.checkpoint = checkpoint;
  }
}

export function isSiopV2Error(value: Error): value is SiopV2Error {
  return value instanceof SiopV2Error;
}

export function refuse(
  code: SiopV2ErrorCode,
  checkpoint: SiopV2Checkpoint,
): never {
  throw new SiopV2Error(code, checkpoint);
}

export function guarded<T>(
  checkpoint: SiopV2Checkpoint,
  fallback: SiopV2ErrorCode,
  step: () => T,
): T {
  try {
    return step();
  } catch (thrown) {
    if (thrown instanceof SiopV2Error) throw thrown;
    throw new SiopV2Error(fallback, checkpoint);
  }
}

export async function guardedAsync<T>(
  checkpoint: SiopV2Checkpoint,
  fallback: SiopV2ErrorCode,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (thrown) {
    if (thrown instanceof SiopV2Error) throw thrown;
    throw new SiopV2Error(fallback, checkpoint);
  }
}
