import { Hono } from "hono";
import type { Variables } from "../middleware/context.js";
import {
  HostAssertion,
  HostChallenge,
  beginHostAuthorization,
  completeHostAuthorization,
} from "../services/host-authorization.js";
import {
  hostAuthorizationPage,
  hostAuthorizationScript,
} from "../ui/host-authorization-page.js";
import { sharedStyles } from "../ui/interaction-pages.js";

export const hostAuthorizationRoutes = new Hono<{ Variables: Variables }>();
hostAuthorizationRoutes.get("/ceremony.css", (c) => {
  c.header("Content-Type", "text/css; charset=utf-8");
  return c.body(sharedStyles);
});
hostAuthorizationRoutes.get("/ceremony.js", (c) => {
  c.header("Content-Type", "text/javascript; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(hostAuthorizationScript);
});
hostAuthorizationRoutes.get("/ceremony", (c) => {
  const origin = c.req.query("origin") ?? "";
  const state = c.req.query("state") ?? "";
  const ctx = c.get("ctx");
  if (
    !ctx.hostAuthorizationAudiences.length ||
    !ctx.config.corsOrigins.includes(origin) ||
    !/^[a-zA-Z0-9_-]{43}$/.test(state)
  )
    return c.text("Authorization unavailable", 403);
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  c.header("Cross-Origin-Opener-Policy", "unsafe-none");
  return c.html(hostAuthorizationPage);
});
hostAuthorizationRoutes.use("*", async (c, next) => {
  if (!c.get("ctx").hostAuthorizationAudiences.length)
    return c.json({ error: "not_found" }, 404);
  if (!c.get("provisionalSessionId") || !c.get("principalId"))
    return c.json({ error: "unauthorized" }, 401);
  c.header("Cache-Control", "no-store");
  return next();
});
hostAuthorizationRoutes.post("/options", async (c) => {
  const parsed = HostChallenge.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  try {
    return c.json(
      await beginHostAuthorization(
        c.get("ctx"),
        c.get("principalId") ?? "",
        parsed.data,
      ),
    );
  } catch {
    return c.json({ error: "host_authorization_refused" }, 403);
  }
});
hostAuthorizationRoutes.post("/verify", async (c) => {
  const parsed = HostAssertion.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  try {
    const assertion = await completeHostAuthorization(
      c.get("ctx"),
      c.get("principalId") ?? "",
      parsed.data,
    );
    return c.json({ assertion });
  } catch {
    return c.json({ error: "host_authorization_refused" }, 403);
  }
});
