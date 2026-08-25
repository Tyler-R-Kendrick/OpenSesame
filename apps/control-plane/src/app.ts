import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.js";
import { authMiddleware } from "./middleware/auth.js";
import { type Variables, withContext } from "./middleware/context.js";
import { apiSecurityHeaders } from "./middleware/security-headers.js";
import { agentRoutes } from "./routes/agents.js";
import { appClaimRoutes } from "./routes/app-claims.js";
import { auditRoutes } from "./routes/audit.js";
import { authorizationRequestRoutes } from "./routes/authorization-requests.js";
import { claimRoutes } from "./routes/claims.js";
import { deviceRoutes } from "./routes/device.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { federatedProviderRoutes } from "./routes/federated-providers.js";
import { createFederatedSessionRoutes } from "./routes/federated-session.js";
import { healthRoutes } from "./routes/health.js";
import { createInteractionRoutes } from "./routes/interactions.js";
import { mfaRoutes } from "./routes/mfa.js";
import { oauthClientRoutes } from "./routes/oauth-clients.js";
import { organizationRoutes } from "./routes/organizations.js";
import { originClientAdminRoutes } from "./routes/origin-clients-admin.js";
import { principalRoutes } from "./routes/principals.js";
import { projectRoutes } from "./routes/projects.js";
import { webhookRoutes } from "./routes/webhooks.js";

export function createHonoApp(ctx: AppContext): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", async (c, next) => {
    await next();
    if (c.req.header("Access-Control-Request-Private-Network") === "true") {
      c.header("Access-Control-Allow-Private-Network", "true");
    }
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    }),
  );
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
  app.route("/v1/authorization-requests", authorizationRequestRoutes);
  app.route("/v1/webhooks", webhookRoutes);
  app.route("/v1/agents", agentRoutes);
  app.route("/v1/mfa", mfaRoutes);
  app.route("/v1/device", deviceRoutes);
  app.route("/v1/organizations", organizationRoutes);
  app.route("/v1/oauth/clients", oauthClientRoutes);
  app.route("/v1/oauth/applications", appClaimRoutes);
  app.route("/v1/oauth/admin/clients", originClientAdminRoutes);
  app.route("/v1/audit", auditRoutes);
  // Public provider catalog (ADR 0055 / C8): id, label, kind, browserCapable —
  // never issuers, endpoints or secrets.
  app.route("/v1/federated", federatedProviderRoutes);
  // Brokered session adoption (C13): a static page exchanges the access token
  // from its origin-profile code flow for a first-party bearer bound to the
  // same principal. Mounted on the principal prefix, in its own router because
  // routes/principals.ts belongs to another swarm this cycle.
  app.route("/v1/principals", createFederatedSessionRoutes());
  // INTEGRATOR — routes whose modules are landing with the other swarms of
  // this change. Each is mounted here the moment its module exists; the mount
  // line is the only thing missing, and every owner has left a factory with
  // the signature its contract names:
  //   GET  /v1/saml/metadata, POST /v1/saml/acs — C14, S9 (routes/saml.ts)
  //   /scim/v2/*                             — C15, S10 (routes/scim.ts)
  //   /v1/organizations/:id/domains          — C16, S10 (routes/org-domains.ts)
  //   POST /v1/federated/backchannel-logout  — C17, S10 (routes/backchannel-logout.ts)
  //   /v1/federated/admin/byo-upstreams      — D14, S10 (routes/byo-admin.ts)
  //   /v1/auth/*                             — C20, S11 (routes/auth-upstream.ts)
  //   /v1/organizations/:id/ldap             — C21, S12 (routes/org-ldap.ts)
  // The interaction sub-routers (C9: byo, org, realm, ldap, saml-complete)
  // mount inside createInteractionRoutes, not here.
  // The oidc-provider interaction slot (ADR 0050 F6): /auth 303-redirects
  // here for login/consent. server.ts only intercepts protocol paths, so
  // /interaction/* falls through to Hono.
  app.route("/interaction", createInteractionRoutes());
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
