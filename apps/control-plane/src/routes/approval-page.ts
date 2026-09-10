import { Hono } from "hono";
import type { Variables } from "../middleware/context.js";
import { approvalPage, approvalScript } from "../ui/approval-page.js";
import { sharedStyles } from "../ui/interaction-pages.js";

/** Static ceremony only; all reads and decisions retain the authenticated inbox routes. */
export const approvalPageRoutes = new Hono<{ Variables: Variables }>();
approvalPageRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  return next();
});
approvalPageRoutes.get("/ceremony", (c) => c.html(approvalPage));
approvalPageRoutes.get("/ceremony.js", (c) => {
  c.header("Content-Type", "text/javascript; charset=utf-8");
  return c.body(approvalScript);
});
approvalPageRoutes.get("/ceremony.css", (c) => {
  c.header("Content-Type", "text/css; charset=utf-8");
  return c.body(
    `${sharedStyles}\npre { white-space: pre-wrap; overflow-wrap: anywhere; }`,
  );
});
