import { createMiddleware } from "hono/factory";

/** Security headers for HTML claim / verification pages. */
export function claimPageSecurityHeaders() {
  return createMiddleware(async (c, next) => {
    await next();
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
  });
}
