import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { Variables } from "./context.js";

/** Constant-time bearer compare; hashes first so length never leaks. */
export function tokenEq(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * Gate deployment-admin routes on the server-only operator token
 * (`OPENSESAME_OPERATOR_TOKEN`). This is not a principal credential: the
 * operator acts on clients it does not own (ADR 0050 R-B), so no session or
 * provisional token is accepted here. The token is fail-closed — an empty
 * configured token (production already refuses to boot without one) matches
 * nothing.
 */
export function requireOperatorToken() {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const ctx = c.get("ctx");
    const expected = ctx.config.operatorToken;
    const auth = c.req.header("authorization") ?? "";
    const presented = auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : "";
    if (!expected || !presented || !tokenEq(presented, expected)) {
      return c.json(
        { error: "unauthorized", message: "Operator token required" },
        401,
      );
    }
    await next();
  });
}
