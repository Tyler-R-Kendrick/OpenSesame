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
import { createUpstreamAuthRoutes } from "./routes/auth-upstream.js";
import { authorizationRequestRoutes } from "./routes/authorization-requests.js";
import { createBackchannelLogoutRoutes } from "./routes/backchannel-logout.js";
import { createByoAdminRoutes } from "./routes/byo-admin.js";
import { byoPublicRoutes } from "./routes/byo-public.js";
import { claimRoutes } from "./routes/claims.js";
import { deviceRoutes } from "./routes/device.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { createFederatedCallbackRoutes } from "./routes/federated-callback.js";
import { federatedProviderRoutes } from "./routes/federated-providers.js";
import { createFederatedSessionRoutes } from "./routes/federated-session.js";
import { healthRoutes } from "./routes/health.js";
import { createInteractionRoutes } from "./routes/interactions.js";
import { mfaRoutes } from "./routes/mfa.js";
import { oauthClientRoutes } from "./routes/oauth-clients.js";
import { createOrgDomainRoutes } from "./routes/org-domains.js";
import { createOrgLdapRoutes } from "./routes/org-ldap.js";
import { organizationRoutes } from "./routes/organizations.js";
import { originClientAdminRoutes } from "./routes/origin-clients-admin.js";
import { principalRoutes } from "./routes/principals.js";
import { projectRoutes } from "./routes/projects.js";
import { createSamlRoutes } from "./routes/saml.js";
import { createScimRoutes } from "./routes/scim.js";
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
  // Visitor-facing BYO issuer registration — the JSON twin of the hosted
  // login page's form POST (routes/byo-public.ts).
  app.route("/v1/federated", byoPublicRoutes);
  // The stable, deployment-wide federated callback (ADR 0055): one registered
  // redirect URI for every upstream an operator or an RFC 7591 registration
  // configured, because Google, Entra and Apple match it byte for byte and a
  // path naming one interaction can never be registered. It completes nothing
  // — see routes/federated-callback.ts.
  app.route("/v1/federated", createFederatedCallbackRoutes());
  // Brokered session adoption (C13): a static page exchanges the access token
  // from its origin-profile code flow for a first-party bearer bound to the
  // same principal. Mounted on the principal prefix, in its own router because
  // routes/principals.ts belongs to another swarm this cycle.
  app.route("/v1/principals", createFederatedSessionRoutes());
  // Native SAML SP (C14 / ADR 0056): the metadata an IdP is configured from,
  // and the assertion consumer service it posts back to. Both are public by
  // protocol — the assertion's XML-DSig is the authority, not a session.
  app.route("/v1/saml", createSamlRoutes());
  // SCIM 2.0 directory provisioning (C15) and the organization email domains
  // home-realm discovery routes on (C16). Both hang off the organization
  // prefix because both are per-tenant: the SCIM base URL a directory is
  // configured with is `/v1/organizations/<id>/scim/v2`.
  app.route("/v1/organizations", createScimRoutes());
  app.route("/v1/organizations", createOrgDomainRoutes());
  // Owner-facing directory configuration and the manual sync trigger (C21):
  // `/v1/organizations/:id/ldap`, in its own router because
  // routes/organizations.ts belongs to another swarm this cycle.
  app.route("/v1/organizations", createOrgLdapRoutes());
  // OIDC Back-Channel Logout (C17): unauthenticated by design — the issuer's
  // signature is the credential — and rate-limited because of it.
  app.route("/v1/federated", createBackchannelLogoutRoutes());
  // Operator lifecycle for visitor-registered BYO upstreams (D14).
  app.route("/v1/federated/admin/byo-upstreams", createByoAdminRoutes());
  // The Better Auth mount (C20 / ADR 0057), enabling exactly one sign-in
  // method: email magic-link. The router allowlists a single Better Auth path
  // and answers 404 to the rest, so social stays unreachable (T22) and the
  // Better Auth user record never crosses this boundary (T33).
  app.route("/v1/auth", createUpstreamAuthRoutes(ctx));
  // The interaction sub-routers (C9: byo, email, ldap, org, realm, saml)
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
