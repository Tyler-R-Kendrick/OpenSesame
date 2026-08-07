import type { Context, MiddlewareHandler, Next } from "hono";
import type { OpenSesameVerifier, VerifiedIdentity } from "./verifier.js";

export type OpenSesameAuthVariables = {
  identity: VerifiedIdentity;
};

export interface OpenSesameAuthOptions {
  verifier: OpenSesameVerifier;
  /** Custom extractor; default Bearer scheme. */
  getToken?: (c: Context) => string | undefined;
  onError?: (c: Context, error: unknown) => Response | Promise<Response>;
}

function defaultToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(/\s+/u);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}

/** Hono middleware that verifies OpenSesame access tokens and sets `c.get('identity')`. */
export function openSesameAuth(options: OpenSesameAuthOptions): MiddlewareHandler {
  const getToken = options.getToken ?? defaultToken;
  return async (c: Context, next: Next) => {
    const token = getToken(c);
    if (!token) {
      if (options.onError) {
        return options.onError(c, new Error("Missing bearer token"));
      }
      return c.json({ error: "unauthorized", error_description: "Missing bearer token" }, 401);
    }
    try {
      const identity = await options.verifier.verifyAccessToken(token);
      c.set("identity", identity);
      await next();
    } catch (error) {
      if (options.onError) {
        return options.onError(c, error);
      }
      return c.json(
        {
          error: "invalid_token",
          error_description: error instanceof Error ? error.message : "invalid token",
        },
        401,
      );
    }
  };
}
