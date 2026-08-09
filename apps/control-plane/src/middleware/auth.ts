import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext } from "../context.js";
import type { Variables } from "./context.js";

/**
 * Resolve principal from Bearer token or provisional cookie.
 * Only `pst_…` access tokens authenticate; session ids (`ps_…`) never do.
 * `Authorization: Bearer prn_…` is opt-in for local tests only
 * (`OPENSESAME_ALLOW_PRINCIPAL_BEARER=true`, never in production).
 */
function resolveProvisionalSession(
  ctx: AppContext,
  token: string,
): { principalId: string; sessionId: string } | undefined {
  if (!token.startsWith("pst_")) return undefined;
  const sessionId = ctx.stores.provisionalTokens.get(token);
  if (!sessionId) return undefined;
  const session = ctx.stores.provisionalSessions.get(sessionId);
  if (!session || session.expiresAt <= ctx.clock() || session.revokedAt) {
    return undefined;
  }
  return { principalId: session.principalId, sessionId: session.id };
}

/** Methods that only read. A forged read is not a forged write. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether an ambient cookie may authenticate this request.
 *
 * A cookie is sent by the browser whether or not the page meant to send it, so on
 * its own it says nothing about who asked. `SameSite=Lax` stops the obvious
 * cross-site form post, but it is a browser default, it does not separate
 * sibling origins on the same site, and it is not a rule this service enforces.
 *
 * So a mutation authenticated by cookie must also carry an `Origin` this
 * deployment listed, or the service's own origin. A bearer token is unaffected:
 * a caller that had to attach a token was not tricked into attaching it.
 */
function cookieAuthAllowed(
  ctx: AppContext,
  method: string,
  origin: string | undefined,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (!origin) return false;
  if (ctx.config.corsOrigins.includes(origin)) return true;
  try {
    return new URL(ctx.config.publicUrl).origin === origin;
  } catch {
    return false;
  }
}

export function authMiddleware() {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const ctx = c.get("ctx");
    const cookieName = ctx.config.provisionalCookieName;

    const auth = c.req.header("authorization");
    if (auth?.toLowerCase().startsWith("bearer ")) {
      const token = auth.slice(7).trim();
      const resolved = resolveProvisionalSession(ctx, token);
      if (resolved) {
        c.set("principalId", resolved.principalId);
        c.set("provisionalSessionId", resolved.sessionId);
        await next();
        return;
      }
      if (ctx.config.allowPrincipalBearer && token.startsWith("prn_")) {
        const principal = await ctx.repos.principals.getById(token);
        if (principal) {
          c.set("principalId", principal.id);
          await next();
          return;
        }
      }
    }

    const cookieVal = getCookie(c, cookieName);
    if (
      cookieVal &&
      cookieAuthAllowed(ctx, c.req.method, c.req.header("origin"))
    ) {
      const resolved = resolveProvisionalSession(ctx, cookieVal);
      if (resolved) {
        c.set("principalId", resolved.principalId);
        c.set("provisionalSessionId", resolved.sessionId);
      }
    }

    await next();
  });
}

export function requirePrincipal() {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    if (!c.get("principalId")) {
      return c.json(
        { error: "unauthorized", message: "Authentication required" },
        401,
      );
    }
    await next();
  });
}
