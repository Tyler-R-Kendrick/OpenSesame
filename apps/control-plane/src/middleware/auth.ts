import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
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
    if (cookieVal) {
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
      return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
    }
    await next();
  });
}
