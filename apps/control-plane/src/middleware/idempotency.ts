import { createMiddleware } from "hono/factory";
import type { Variables } from "./context.js";

/**
 * Replay cached responses for mutating endpoints when Idempotency-Key is set.
 */
export function idempotencyMiddleware(scope: string) {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (!key) {
      await next();
      return;
    }
    const ctx = c.get("ctx");
    const cacheKey = `${scope}:${c.req.method}:${c.req.path}:${key}`;
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
        const body = await clone.json();
        const headers: Record<string, string> = {};
        const setCookie = c.res.headers.get("set-cookie");
        if (setCookie) headers["set-cookie"] = setCookie;
        ctx.stores.idempotency.set(cacheKey, {
          status: c.res.status,
          body,
          headers,
        });
      } catch {
        // non-JSON success — skip cache
      }
    }
  });
}
