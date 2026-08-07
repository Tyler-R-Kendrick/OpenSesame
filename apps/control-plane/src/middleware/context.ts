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
      c.req.header("x-correlation-id") ?? crypto.randomUUID(),
    );
    await next();
  });
}
