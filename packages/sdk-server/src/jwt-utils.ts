import { decodeProtectedHeader, errors as joseErrors } from "jose";
import { AuthError } from "./errors.js";
import { type BoundaryValue } from "@opensesame/os-domain";

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

export function mapJwtVerifyError(error: BoundaryValue): AuthError {
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
    cause: error instanceof Error ? error : undefined,
  });
}
