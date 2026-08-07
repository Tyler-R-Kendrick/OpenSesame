import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Variables } from "./context.js";

/**
 * Resolve principal from Bearer token or provisional cookie.
 * Bearer may be a provisional session token or `prn_…` principal id (dev/tests).
 */
export function authMiddleware() {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const ctx = c.get("ctx");
    const cookieName = ctx.config.provisionalCookieName;

    const auth = c.req.header("authorization");
    if (auth?.toLowerCase().startsWith("bearer ")) {
      const token = auth.slice(7).trim();
      const sessionId = ctx.stores.provisionalTokens.get(token);
      if (sessionId) {
        const session = ctx.stores.provisionalSessions.get(sessionId);
        if (session && session.expiresAt > ctx.clock() && !session.revokedAt) {
          c.set("principalId", session.principalId);
          c.set("provisionalSessionId", session.id);
          await next();
          return;
        }
      }
      if (token.startsWith("prn_")) {
        const principal = await ctx.repos.principals.getById(token);
        if (principal) {
          c.set("principalId", principal.id);
          await next();
          return;
        }
      }
    }

    const cookieVal = getCookie(c, cookieName);
    if (cookieVal) {
      const sessionId = ctx.stores.provisionalTokens.get(cookieVal) ?? cookieVal;
      const session = ctx.stores.provisionalSessions.get(sessionId);
      if (session && session.expiresAt > ctx.clock() && !session.revokedAt) {
        c.set("principalId", session.principalId);
        c.set("provisionalSessionId", session.id);
      }
    }

    await next();
  });
}

export function requirePrincipal() {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    if (!c.get("principalId")) {
      return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
    }
    await next();
  });
}
