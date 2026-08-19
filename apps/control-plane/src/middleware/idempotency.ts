import { createMiddleware } from "hono/factory";
import type { Variables } from "./context.js";
import { serializeKeyed } from "../serialize.js";

/** Cached responses are short-lived: they hold the original body verbatim. */
export const IDEMPOTENCY_TTL_MS = 10 * 60_000;
/** Keys are client-chosen, so the map needs a ceiling. */
export const IDEMPOTENCY_MAX_ENTRIES = 2048;
export const IDEMPOTENCY_MAX_KEY_LENGTH = 255;

/**
 * Replay cached responses for mutating endpoints when Idempotency-Key is set.
 *
 * Entries are bound to the calling principal. The key is client-chosen and the
 * cached body frequently contains credentials (claim tokens, client secrets,
 * provisional access tokens), so an unscoped cache would hand a victim's
 * response to anyone who reused their key. Anonymous callers are not cached at
 * all: there is no identity to bind an entry to.
 */
export function idempotencyMiddleware(scope: string) {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (!key || key.length > IDEMPOTENCY_MAX_KEY_LENGTH) {
      await next();
      return;
    }
    const caller = c.get("principalId");
    if (!caller) {
      await next();
      return;
    }
    const ctx = c.get("ctx");
    const now = ctx.clock().getTime();
    const cacheKey = `${scope}:${caller}:${c.req.method}:${c.req.path}:${key}`;

    return serializeKeyed(ctx.stores.idempotencyLocks, cacheKey, async () => {
    for (const [k, record] of ctx.stores.idempotency) {
      if (record.expiresAt <= now) ctx.stores.idempotency.delete(k);
    }

    const cached = ctx.stores.idempotency.get(cacheKey);
    if (cached) {
      c.header("Idempotency-Replayed", "true");
      return c.json(cached.body as never, cached.status as 200);
    }

    await next();

    if (c.res && c.res.status >= 200 && c.res.status < 300) {
      if (ctx.stores.idempotency.size >= IDEMPOTENCY_MAX_ENTRIES) return;
      try {
        const clone = c.res.clone();
        const body = await clone.json();
        ctx.stores.idempotency.set(cacheKey, {
          status: c.res.status,
          body,
          expiresAt: now + IDEMPOTENCY_TTL_MS,
        });
      } catch {
        // non-JSON success — skip cache
      }
    }
    });
  });
}
