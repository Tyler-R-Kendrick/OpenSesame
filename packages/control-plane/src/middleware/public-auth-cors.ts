import {
  type AuthenticationApplication,
  type JsonValue,
  isTypeofObject,
} from "@opensesame/os-domain";
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../context.js";
import type { Variables } from "./context.js";

function originAllowed(
  origin: string | undefined,
  application: AuthenticationApplication | undefined,
): origin is string {
  return (
    !!origin &&
    origin !== "null" &&
    origin !== "*" &&
    application?.state === "active" &&
    application.origins.includes(origin)
  );
}

const PUBLIC = "/v1/authentication/public/";
const ROUTE =
  /^\/v1\/authentication\/public\/applications\/([A-Za-z0-9_-]+)\/(register|signin)\/(options|verify)$/;

function matchesApplication(body: JsonValue, applicationId: string): boolean {
  return (
    !!body &&
    isTypeofObject(body) &&
    "applicationId" in body &&
    body.applicationId === applicationId
  );
}

/** Resolve the application before either preflight or credential processing. */
export function publicAuthenticationCors(
  ctx: AppContext,
): MiddlewareHandler<{ Variables: Variables }> {
  return async (c, next) => {
    if (!c.req.path.startsWith(PUBLIC)) return next();
    c.header("Vary", "Origin");
    const match = ROUTE.exec(c.req.path);
    const applicationId = match?.[1];
    if (!applicationId)
      return c.json({ error: "public_auth_route_retired" }, 410);
    const origin = c.req.header("Origin");
    const application =
      await ctx.authenticationStores.applications.get(applicationId);
    if (!originAllowed(origin, application)) {
      return c.json({ error: "not_found" }, 404);
    }
    if (c.req.method === "OPTIONS") {
      const method = c.req.header("Access-Control-Request-Method");
      const headers = (c.req.header("Access-Control-Request-Headers") ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (
        method !== "POST" ||
        headers.some((header) => header !== "content-type")
      ) {
        return c.json({ error: "not_found" }, 404);
      }
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "POST");
      c.header("Access-Control-Allow-Headers", "Content-Type");
      return c.body(null, 204);
    }
    if (c.req.method !== "POST") return c.json({ error: "not_found" }, 404);
    const body = await c.req.json<JsonValue>().catch(() => null);
    if (!matchesApplication(body, applicationId)) {
      return c.json({ error: "validation_error" }, 400);
    }
    c.header("Access-Control-Allow-Origin", origin);
    return next();
  };
}
