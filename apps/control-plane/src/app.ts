import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.js";
import { withContext, type Variables } from "./middleware/context.js";
import { authMiddleware } from "./middleware/auth.js";
import { apiSecurityHeaders } from "./middleware/security-headers.js";
import { healthRoutes } from "./routes/health.js";
import { principalRoutes } from "./routes/principals.js";
import { projectRoutes } from "./routes/projects.js";
import { claimRoutes } from "./routes/claims.js";
import { agentRoutes } from "./routes/agents.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { mfaRoutes } from "./routes/mfa.js";
import { deviceRoutes } from "./routes/device.js";
import { organizationRoutes } from "./routes/organizations.js";
import { oauthClientRoutes } from "./routes/oauth-clients.js";
import { auditRoutes } from "./routes/audit.js";

export function createHonoApp(ctx: AppContext): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return ctx.config.corsOrigins[0] ?? "";
        return ctx.config.corsOrigins.includes(origin) ? origin : "";
      },
      credentials: true,
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Request-Id",
        "Idempotency-Key",
        // Reading and completing a claim carries its bearer here rather than in
        // Authorization, which names the principal. Omitting it fails the
        // preflight and takes the whole ceremony with it.
        "X-Claim-Token",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  app.use("*", withContext(ctx));
  app.use("*", apiSecurityHeaders());
  app.use("*", authMiddleware());

  app.route("/v1/health", healthRoutes);
  app.route("/v1/principals", principalRoutes);
  app.route("/v1/projects", projectRoutes);
  app.route("/v1/claims", claimRoutes);
  app.route("/v1/agents", agentRoutes);
  app.route("/v1/mfa", mfaRoutes);
  app.route("/v1/device", deviceRoutes);
  app.route("/v1/organizations", organizationRoutes);
  app.route("/v1/oauth/clients", oauthClientRoutes);
  app.route("/v1/audit", auditRoutes);
  app.route("/", discoveryRoutes);

  app.onError((err, c) => {
    ctx.log.error({ err }, "request failed");
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    // An unhandled throw is not an answer: its message carries whatever the
    // failure happened to be holding — a query, a path, a driver's account of
    // itself. The log has it; the client gets the correlation id to quote.
    return c.json(
      {
        error: "internal_error",
        message: "The request could not be completed.",
        correlationId: c.get("correlationId"),
      },
      500,
    );
  });

  return app;
}
