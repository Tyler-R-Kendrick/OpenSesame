import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { jwtVerify } from "jose";
import { AuthError } from "./errors.js";
import {
  ID_TOKEN_ALGORITHMS,
  assertAllowedJwtAlgorithm,
  mapJwtVerifyError,
  trimSlash,
} from "./jwt-utils.js";
import { createJwksKeySource } from "./verifier.js";

export interface VerifiedIdToken {
  sub: string;
  iss: string;
  aud: string | string[];
  nonce?: string;
  payload: JWTPayload;
}

export interface VerifyIdTokenOptions {
  issuer: string;
  audience: string;
  /** Override JWKS URI. Operator-configured; fenced as a secure URL. */
  jwksUri?: string;
  /** Inject local JWKS for tests. */
  jwks?: { keys: unknown[] };
  nonce?: string;
  clockToleranceSeconds?: number;
  fetchImpl?: typeof fetch;
}

/** Verify an OpenID Connect ID token (RS256/ES256 only, fail-closed). */
export async function verifyIdToken(
  token: string,
  options: VerifyIdTokenOptions,
): Promise<VerifiedIdToken> {
  assertAllowedJwtAlgorithm(token, ID_TOKEN_ALGORITHMS);

  const issuer = trimSlash(options.issuer);
  const getKey: JWTVerifyGetKey = await createJwksKeySource({
    issuer,
    ...(options.jwksUri !== undefined ? { jwksUri: options.jwksUri } : {}),
    ...(options.jwks !== undefined ? { jwks: options.jwks } : {}),
    ...(options.fetchImpl !== undefined
      ? { fetchImpl: options.fetchImpl }
      : {}),
  })();

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getKey, {
      issuer,
      audience: options.audience,
      algorithms: [...ID_TOKEN_ALGORITHMS],
      clockTolerance: options.clockToleranceSeconds ?? 5,
    }));
  } catch (error) {
    throw mapJwtVerifyError(error);
  }

  if (payload.sub === undefined || payload.sub === "") {
    throw new AuthError("missing_claim", "Token missing sub");
  }
  if (payload.iss === undefined) {
    throw new AuthError("missing_claim", "Token missing iss");
  }

  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    throw new AuthError("nonce_mismatch", "Token nonce does not match");
  }

  const verified: VerifiedIdToken = {
    sub: payload.sub,
    iss: payload.iss,
    aud: (payload.aud as string | string[]) ?? options.audience,
    payload,
  };
  if (typeof payload.nonce === "string") {
    verified.nonce = payload.nonce;
  }
  return verified;
}
