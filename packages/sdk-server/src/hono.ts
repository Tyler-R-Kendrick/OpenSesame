import type { Context, MiddlewareHandler, Next } from "hono";
import { AuthError, AuthorizationError } from "./errors.js";
import type { OpenSesameVerifier, VerifiedIdentity } from "./verifier.js";
import { type BoundaryValue } from "@opensesame/os-domain";

export type OpenSesameAuthVariables = {
  identity: VerifiedIdentity;
};

export interface OpenSesameAuthOptions {
  verifier: OpenSesameVerifier;
  /** Custom extractor; default Bearer scheme. */
  getToken?: (c: Context) => string | undefined;
  onError?: (c: Context, error: BoundaryValue) => Response | Promise<Response>;
}

function defaultToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(/\s+/u);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}

/** RFC 6750 says a 401 from a bearer-protected resource carries the challenge. */
function unauthorized(
  c: Context,
  error: string,
  description: string,
): Response {
  return c.json({ error, error_description: description }, 401, {
    "WWW-Authenticate": `Bearer error="${error}", error_description="${description}"`,
  });
}

/** Hono middleware that verifies OpenSesame access tokens and sets `c.get('identity')`. */
export function openSesameAuth(
  options: OpenSesameAuthOptions,
): MiddlewareHandler {
  const getToken = options.getToken ?? defaultToken;
  return async (c: Context, next: Next) => {
    const token = getToken(c);
    if (!token) {
      if (options.onError) {
        return options.onError(c, new Error("Missing bearer token"));
      }
      return unauthorized(c, "unauthorized", "Missing bearer token");
    }
    let identity: VerifiedIdentity;
    try {
      identity = await options.verifier.verifyAccessToken(token);
    } catch (error) {
      if (options.onError) {
        return options.onError(c, error);
      }
      if (error instanceof AuthorizationError) {
        return c.json(
          { error: error.code, error_description: error.message },
          403,
        );
      }
      if (error instanceof AuthError) {
        return unauthorized(c, error.code, error.message);
      }
      // The reason a token failed is for the resource server's own logs. Handing
      // it back describes the verifier's internals to whoever is probing it.
      return unauthorized(c, "invalid_token", "The access token is not valid");
    }
    c.set("identity", identity);
    // Outside the catch: a handler's own failure is not an authentication
    // failure, and returning 401 for it both misleads the caller and can echo
    // an internal error message back out.
    await next();
  };
}
