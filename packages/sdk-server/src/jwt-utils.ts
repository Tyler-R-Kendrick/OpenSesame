import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type JWTPayload,
  decodeProtectedHeader,
  errors as joseErrors,
} from "jose";
import { AuthError } from "./errors.js";

/** ID-token algorithms (ADR 0050 F7). Access-token verification may be wider. */
export const ID_TOKEN_ALGORITHMS = ["RS256", "ES256"] as const;
export type IdTokenAlgorithm = (typeof ID_TOKEN_ALGORITHMS)[number];

export function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

export function hasRequiredScopes(
  scope: string | undefined,
  required: string[],
): boolean {
  if (required.length === 0) return true;
  const have = new Set((scope ?? "").split(/\s+/u).filter(Boolean));
  return required.every((s) => have.has(s));
}

/** Narrow a custom JOSE payload claim without coercing malformed values. */
export function isJwtString(value: BoundaryValue): value is string {
  return isString(value);
}

const MAX_JWT_JSON_DEPTH = 32;

function isJwtJsonValue(value: BoundaryValue, depth = 0): value is JsonValue {
  if (depth > MAX_JWT_JSON_DEPTH) return false;
  if (
    value === null ||
    value === true ||
    value === false ||
    isString(value) ||
    isNumber(value)
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJwtJsonValue(entry, depth + 1));
  }
  return (
    isJsonObject(value) &&
    Object.values(value).every((entry) => isJwtJsonValue(entry, depth + 1))
  );
}

/** Normalize jose's broad payload dictionary at the verified JWT boundary. */
export function parseJwtPayload(payload: BoundaryValue): JsonObject {
  if (!isJsonObject(payload) || !Object.values(payload).every(isJwtJsonValue)) {
    throw new AuthError("invalid_token", "Token payload is not valid JSON");
  }
  return payload;
}

export function readJwtAudience(
  value: BoundaryValue,
): string | string[] | undefined {
  if (isJwtString(value)) return value;
  if (!Array.isArray(value)) return undefined;
  const audience: string[] = [];
  for (const entry of value) {
    if (!isJwtString(entry)) return undefined;
    audience.push(entry);
  }
  return audience;
}

export function assertAllowedJwtAlgorithm(
  token: string,
  allowed: readonly string[] = ID_TOKEN_ALGORITHMS,
): void {
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw new AuthError("invalid_token", "Token header is malformed");
  }

  if (alg === undefined || alg.toLowerCase() === "none") {
    throw new AuthError(
      "invalid_algorithm",
      "Token uses a disallowed signing algorithm",
    );
  }

  if (!allowed.includes(alg)) {
    throw new AuthError(
      "invalid_algorithm",
      "Token uses a disallowed signing algorithm",
    );
  }
}

export function mapJwtVerifyError(error: Error | undefined): AuthError {
  if (error instanceof AuthError) return error;

  if (error instanceof joseErrors.JWTExpired) {
    return new AuthError("token_expired", "Token has expired", {
      cause: error,
    });
  }

  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case "iss":
        return new AuthError("invalid_issuer", "Token issuer is invalid", {
          cause: error,
        });
      case "aud":
        return new AuthError("invalid_audience", "Token audience is invalid", {
          cause: error,
        });
      case "exp":
        return new AuthError("token_expired", "Token has expired", {
          cause: error,
        });
      case "nbf":
        return new AuthError("invalid_token", "Token is not yet valid", {
          cause: error,
        });
      default:
        return new AuthError("invalid_token", "Token claim validation failed", {
          cause: error,
        });
    }
  }

  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new AuthError(
      "invalid_token",
      "Token signature verification failed",
      { cause: error },
    );
  }

  if (error instanceof joseErrors.JOSEError) {
    return new AuthError("invalid_token", "Token verification failed", {
      cause: error,
    });
  }

  return new AuthError("invalid_token", "Token verification failed", {
    cause: error,
  });
}
