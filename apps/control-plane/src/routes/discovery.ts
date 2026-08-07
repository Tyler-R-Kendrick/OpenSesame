import { Hono } from "hono";
import type { Variables } from "../middleware/context.js";

export const discoveryRoutes = new Hono<{ Variables: Variables }>();

discoveryRoutes.get("/auth.md", (c) => {
  const ctx = c.get("ctx");
  const { publicUrl, issuer } = ctx.config;
  const md = `# OpenSesame Auth

issuer: ${issuer}
authorization_endpoint: ${issuer}/auth
token_endpoint: ${issuer}/token
device_authorization_endpoint: ${issuer}/device/auth
jwks_uri: ${issuer}/jwks
registration_endpoint: ${issuer}/reg

## Product APIs

- health: ${publicUrl}/v1/health/live
- provisional: POST ${publicUrl}/v1/principals/provisional
- me: GET ${publicUrl}/v1/principals/me
- temporary project: POST ${publicUrl}/v1/projects/temporary
- claims: ${publicUrl}/v1/claims
- agents: POST ${publicUrl}/v1/agents

## Agent invocation

connection-oriented: true
protected_resource: ${publicUrl}
`;
  return c.text(md, 200, { "content-type": "text/markdown; charset=utf-8" });
});

discoveryRoutes.get("/.well-known/agent-card.json", (c) => {
  const ctx = c.get("ctx");
  return c.json({
    name: "OpenSesame",
    description: "Identity and claim control plane",
    url: ctx.config.publicUrl,
    version: "0.1.0",
    protocolVersion: "0.3",
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "claim",
        name: "Claim",
        description: "Create and complete identity claims",
        tags: ["identity", "claim"],
      },
    ],
    authentication: {
      schemes: ["oauth2", "bearer"],
      credentials: ctx.config.issuer,
    },
  });
});

discoveryRoutes.get("/.well-known/oauth-protected-resource", (c) => {
  const ctx = c.get("ctx");
  return c.json({
    resource: ctx.config.publicUrl,
    authorization_servers: [ctx.config.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "offline_access", "profile", "email"],
    resource_documentation: `${ctx.config.publicUrl}/auth.md`,
  });
});
