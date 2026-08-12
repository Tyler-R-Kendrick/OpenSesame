import { createHash } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Variables } from "./context.js";

export interface IdempotencyOptions {
  /**
   * Fold the claim bearer into the cache key. Set on routes the bearer gates:
   * a cached success is returned before the handler runs, so without this a
   * borrowed Idempotency-Key would answer a request that never presented one.
   * Left off elsewhere, where a stray claim header would only split keys and
   * let the same caller create a second resource.
   */
  bindClaimToken?: boolean;
}

/** A stable digest, short enough for a cache key and never the value itself. */
function tagOf(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 22);
}

/**
 * Who is asking, as far as replay is concerned. Always the principal, since one
 * caller's result is not another's to collect.
 */
function callerTag(
  c: Context<{ Variables: Variables }>,
  principalId: string,
  bindClaimToken: boolean,
): string {
  if (!bindClaimToken) return principalId;
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/iu, "");
  const claim =
    c.req.header("x-claim-token") ??
    (bearer.startsWith("osc_clm_") ? bearer : "");
  // Hashed rather than stored: the key lives in a map that outlives the request.
  return `${principalId}:${claim ? tagOf(claim) : "none"}`;
}

/**
 * Replay cached responses for mutating endpoints when Idempotency-Key is set.
 * Only for a caller the request names: an answer is addressed to a principal, a
 * request body and, where the route says so, a claim bearer.
 */
export function idempotencyMiddleware(
  scope: string,
  options: IdempotencyOptions = {},
) {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const key = c.req.header("idempotency-key");
    // Without a principal there is nobody to address a cached answer to: any
    // caller could quote the key and collect it. On a route that mints a session
    // that would hand over somebody else's token and cookie, so an anonymous
    // request is simply run.
    const principalId = c.get("principalId");
    if (!key || principalId === undefined) {
      await next();
      return;
    }
    const ctx = c.get("ctx");
    const tag = callerTag(c, principalId, options.bindClaimToken === true);
    // The body decides what the handler does, so a key reused with a different
    // one is a different request; replaying the first answer would report a
    // mutation that never ran. Read from a clone so the handler still gets it.
    const body = await c.req.raw.clone().text();
    const cacheKey = `${scope}:${c.req.method}:${c.req.path}:${tag}:${tagOf(body)}:${key}`;
    const cached = ctx.stores.idempotency.get(cacheKey);
    if (cached) {
      if (cached.headers) {
        for (const [h, v] of Object.entries(cached.headers)) {
          c.header(h, v);
        }
      }
      c.header("Idempotency-Replayed", "true");
      return c.json(cached.body as never, cached.status as 200);
    }

    await next();

    if (c.res && c.res.status >= 200 && c.res.status < 300) {
      try {
        const clone = c.res.clone();
        const replayable = await clone.json();
        const headers: Record<string, string> = {};
        const setCookie = c.res.headers.get("set-cookie");
        if (setCookie) headers["set-cookie"] = setCookie;
        ctx.stores.idempotency.set(cacheKey, {
          status: c.res.status,
          body: replayable,
          headers,
        });
      } catch {
        // non-JSON success — skip cache
      }
    }
  });
}
