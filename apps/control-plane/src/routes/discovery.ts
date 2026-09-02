import {
  AGENT_CLAIM_GRANT,
  JWT_BEARER_GRANT,
  advertisedIdentityTypes,
  renderAgentCard,
  renderAuthMd,
} from "@opensesame/agent-protocols";
import { Hono } from "hono";
import type { Variables } from "../middleware/context.js";
import { agentAuthRuntime } from "../services/agent-auth.js";

export const discoveryRoutes = new Hono<{ Variables: Variables }>();

discoveryRoutes.get("/auth.md", (c) => {
  const ctx = c.get("ctx");
  const { publicUrl, issuer, agentAuth } = ctx.config;
  const md = renderAuthMd({
    serviceName: "OpenSesame",
    protectedResource: publicUrl,
    authorizationServer: issuer,
    consoleOrigin: publicUrl,
    capabilities: {
      anonymous: agentAuth.enabled && agentAuth.anonymousEnabled,
      serviceAuth: agentAuth.enabled && agentAuth.serviceAuthEnabled,
      providerAssertion: agentAuth.providerAssertionEnabled,
      events: agentAuth.eventsEnabled,
    },
    preClaimScopes: agentAuth.preClaimScopes,
    postClaimScopes: agentAuth.postClaimScopes,
    scopes: agentAuth.resourceScopes,
    pollIntervalSeconds: agentAuth.pollIntervalSeconds,
    claimTtlSeconds: Math.floor(agentAuth.registrationTtlMs / 1000),
    agentRegisterPath: "/agent/identity",
    provisionalPath: "/v1/principals/provisional",
    claimPath: "/claim",
  });
  return c.text(md, 200, { "content-type": "text/markdown; charset=utf-8" });
});

discoveryRoutes.get("/.well-known/agent-card.json", (c) => {
  const ctx = c.get("ctx");
  return c.json(
    renderAgentCard({
      name: "OpenSesame",
      url: ctx.config.publicUrl,
      capabilities: [
        "anonymous_register",
        "claim_poll",
        "device_authorization",
        "jwt_bearer_assertion_exchange",
      ],
    }),
  );
});

discoveryRoutes.get("/.well-known/oauth-protected-resource", (c) => {
  const ctx = c.get("ctx");
  const resource = ctx.config.publicUrl.endsWith("/")
    ? ctx.config.publicUrl
    : `${ctx.config.publicUrl}/`;
  return c.json({
    resource,
    resource_name: "OpenSesame",
    authorization_servers: [ctx.config.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ctx.config.agentAuth.resourceScopes,
    resource_documentation: `${ctx.config.publicUrl}/auth.md`,
  });
});

discoveryRoutes.get("/.well-known/oauth-authorization-server", (c) => {
  const ctx = c.get("ctx");
  const issuer = ctx.config.issuer.replace(/\/+$/u, "");
  const caps = {
    anonymous:
      ctx.config.agentAuth.enabled && ctx.config.agentAuth.anonymousEnabled,
    serviceAuth:
      ctx.config.agentAuth.enabled && ctx.config.agentAuth.serviceAuthEnabled,
    providerAssertion: ctx.config.agentAuth.providerAssertionEnabled,
    events: ctx.config.agentAuth.eventsEnabled,
  };
  const identityTypes = advertisedIdentityTypes(caps);
  const grants = [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
    JWT_BEARER_GRANT,
    AGENT_CLAIM_GRANT,
  ];
  const agentAuth: Record<string, unknown> = {
    skill: `${ctx.config.publicUrl}/auth.md`,
    identity_endpoint: `${issuer}/agent/identity`,
    claim_endpoint: `${issuer}/agent/identity/claim`,
    identity_types_supported: identityTypes,
  };
  if (caps.events) {
    agentAuth.events_endpoint = `${issuer}/agent/event/notify`;
  }
  if (caps.providerAssertion) {
    agentAuth.identity_assertion = {
      assertion_types_supported: ["urn:ietf:params:oauth:token-type:id-jag"],
    };
  }
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/auth`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    registration_endpoint: `${issuer}/reg`,
    device_authorization_endpoint: `${issuer}/device/auth`,
    revocation_endpoint: `${issuer}/oauth2/revoke`,
    introspection_endpoint: `${issuer}/introspect`,
    grant_types_supported: grants,
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ctx.config.agentAuth.resourceScopes,
    agent_auth: agentAuth,
  });
});

discoveryRoutes.get("/.well-known/agent-auth-jwks.json", async (c) => {
  const runtime = await agentAuthRuntime();
  return c.json({ keys: [runtime.key.publicJwk] });
});
