import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import type { JSONWebKeySet, JWTVerifyGetKey } from "jose";
import { jwtVerify } from "jose";
import { AuthError } from "./errors.js";
import {
  ID_TOKEN_ALGORITHMS,
  assertAllowedJwtAlgorithm,
  isJwtString,
  mapJwtVerifyError,
  parseJwtPayload,
  readJwtAudience,
  trimSlash,
} from "./jwt-utils.js";
import { createJwksKeySource } from "./verifier.js";

export interface VerifiedIdToken {
  sub: string;
  iss: string;
  aud: string | string[];
  nonce?: string;
  payload: JsonObject;
}

export interface VerifyIdTokenOptions {
  issuer: string;
  audience: string;
  /** Override JWKS URI. Operator-configured; fenced as a secure URL. */
  jwksUri?: string;
  /** Inject local JWKS for tests. */
  jwks?: JSONWebKeySet;
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
    ...(options.jwksUri !== undefined
      ? { jwksUri: options.jwksUri }
      : undefined),
    ...(options.jwks !== undefined ? { jwks: options.jwks } : undefined),
    ...(options.fetchImpl !== undefined
      ? { fetchImpl: options.fetchImpl }
      : undefined),
  })();

  let payload: JsonObject;
  try {
    const verified = await jwtVerify(token, getKey, {
      issuer,
      audience: options.audience,
      algorithms: [...ID_TOKEN_ALGORITHMS],
      clockTolerance: options.clockToleranceSeconds ?? 5,
    });
    payload = parseJwtPayload(overlapCast(verified.payload));
  } catch (error) {
    throw mapJwtVerifyError(error instanceof Error ? error : undefined);
  }

  if (!isJwtString(payload.sub) || payload.sub === "") {
    throw new AuthError("missing_claim", "Token missing sub");
  }
  if (!isJwtString(payload.iss)) {
    throw new AuthError("missing_claim", "Token missing iss");
  }

  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    throw new AuthError("nonce_mismatch", "Token nonce does not match");
  }

  const verified: VerifiedIdToken = {
    sub: payload.sub,
    iss: payload.iss,
    aud: readJwtAudience(payload.aud) ?? options.audience,
    payload,
  };
  if (isJwtString(payload.nonce)) {
    verified.nonce = payload.nonce;
  }
  return verified;
}
