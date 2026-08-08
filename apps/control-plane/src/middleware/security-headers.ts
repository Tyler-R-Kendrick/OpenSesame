import { createMiddleware } from "hono/factory";
import type { Variables } from "./context.js";

/** Escape text interpolated into HTML (claim verify page). */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Baseline headers for Identity API JSON/markdown responses. */
export function apiSecurityHeaders() {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    c.header("X-Permitted-Cross-Domain-Policies", "none");
    const publicUrl = c.get("ctx").config.publicUrl;
    if (publicUrl.startsWith("https://")) {
      c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    }
  });
}

/** Security headers for HTML claim / verification pages. */
export function claimPageSecurityHeaders() {
  return createMiddleware(async (c, next) => {
    await next();
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
  });
}
