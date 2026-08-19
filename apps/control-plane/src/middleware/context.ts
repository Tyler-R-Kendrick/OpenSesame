import { createMiddleware } from "hono/factory";
import type { AppContext } from "../context.js";

export type Variables = {
  ctx: AppContext;
  principalId?: string;
  provisionalSessionId?: string;
  correlationId: string;
};

export function withContext(ctx: AppContext) {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    c.set("ctx", ctx);
    c.set(
      "correlationId",
      sanitizeCorrelationId(c.req.header("x-correlation-id")),
    );
    await next();
  });
}

/** Reject log-injection / oversized client correlation ids. */
export function sanitizeCorrelationId(header: string | undefined): string {
  if (header && /^[\w.-]{1,128}$/.test(header)) return header;
  return crypto.randomUUID();
}
