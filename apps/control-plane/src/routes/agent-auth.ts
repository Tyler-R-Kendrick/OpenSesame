import {
  AGENT_CLAIM_GRANT,
  AgentAuthError,
  JWT_BEARER_GRANT,
} from "@opensesame/agent-protocols";
import {
  AgentClaimCompleteRequestSchema,
  AgentClaimInitRequestSchema,
  AgentIdentityRequestSchema,
} from "@opensesame/contracts";
import { overlapCast } from "@opensesame/os-domain";
import { Hono } from "hono";
import type { Variables } from "../middleware/context.js";
import {
  completeClaim,
  exchangeJwtBearer,
  initClaim,
  pollClaimGrant,
  providerAssertionIsAdvertised,
  registerAnonymous,
  registerProviderAssertion,
  registerServiceAuth,
  resolveAgentAccessToken,
  revokeAccessToken,
  revokeRegistration,
} from "../services/agent-auth.js";
import {
  AGENT_AUTH_CLAIM_CSP,
  renderAgentAuthClaimPage,
  renderAgentAuthLoginPage,
  safeAgentAuthReturnTo,
} from "../ui/agent-auth-pages.js";

export const agentAuthRoutes = new Hono<{ Variables: Variables }>();

function isAgentAuthError(err: unknown): err is AgentAuthError {
  if (err instanceof AgentAuthError) return true;
  return (
    err instanceof Error &&
    err.name === "AgentAuthError" &&
    typeof (err as AgentAuthError).status === "number" &&
    typeof (err as AgentAuthError).error === "string" &&
    typeof (err as AgentAuthError).toJSON === "function"
  );
}

agentAuthRoutes.post("/agent/identity", async (c) => {
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
  const ctx = c.get("ctx");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const parsed = AgentIdentityRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const correlationId = c.get("correlationId");
  const headers: { userAgent?: string; origin?: string } = {};
  const userAgent = c.req.header("user-agent");
  const origin = c.req.header("origin");
  if (userAgent) headers.userAgent = userAgent;
  if (origin) headers.origin = origin;
  try {
    if (parsed.data.type === "anonymous") {
      const result = await registerAnonymous(ctx, headers, correlationId);
      return c.json(result, 200);
    }
    if (parsed.data.type === "service_auth") {
      const result = await registerServiceAuth(
        ctx,
        parsed.data.login_hint,
        headers,
        correlationId,
      );
      return c.json(result, 200);
    }
    if (!providerAssertionIsAdvertised(ctx.config.agentAuth)) {
      return c.json(
        {
          error: "identity_assertion_not_enabled",
          error_description:
            "Provider ID-JAG registration is disabled until issuer trust is configured.",
        },
        400,
      );
    }
    const result = await registerProviderAssertion(
      ctx,
      {
        assertionType: parsed.data.assertion_type,
        assertion: parsed.data.assertion,
      },
      headers,
      correlationId,
    );
    return c.json(result, 200);
  } catch (err) {
    if (isAgentAuthError(err)) {
      if (err.status === 401) {
        const maxAge = err.extras?.max_age;
        const description = (err.errorDescription ?? err.error).replace(
          /"/g,
          "",
        );
        const parts = [`AgentAuth error="${err.error}"`];
        if (typeof maxAge === "number") parts.push(`max_age="${maxAge}"`);
        parts.push(`error_description="${description}"`);
        c.header("WWW-Authenticate", parts.join(", "));
      }
      return c.json(err.toJSON(), overlapCast(err.status));
    }
    throw err;
  }
});

agentAuthRoutes.post("/agent/identity/claim", async (c) => {
  const ctx = c.get("ctx");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const parsed = AgentClaimInitRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_claim_token" }, 400);
  }
  try {
    const result = await initClaim(
      ctx,
      parsed.data.claim_token,
      parsed.data.email,
      c.get("correlationId"),
    );
    return c.json(result, 200);
  } catch (err) {
    if (isAgentAuthError(err)) {
      return c.json(err.toJSON(), overlapCast(err.status));
    }
    throw err;
  }
});

agentAuthRoutes.post("/agent/identity/claim/complete", async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId");
  if (!principalId) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const contentType = c.req.header("content-type") ?? "";
  let raw: unknown;
  if (contentType.includes("application/json")) {
    raw = await c.req.json();
  } else {
    const form = await c.req.parseBody();
    raw = form;
  }
  const parsed = AgentClaimCompleteRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const result = await completeClaim(
    ctx,
    principalId,
    parsed.data.claim_attempt_token,
    parsed.data.user_code,
    c.get("correlationId"),
  );
  if (!result.ok) {
    if (contentType.includes("application/json")) {
      return c.json({ error: result.error }, overlapCast(result.status));
    }
    return c.html(
      renderAgentAuthClaimPage({
        error: result.error,
        claimAttemptToken: parsed.data.claim_attempt_token,
      }),
      overlapCast(result.status),
    );
  }
  if (contentType.includes("application/json")) {
    return c.json({ status: "claimed" }, 200);
  }
  return c.html(renderAgentAuthClaimPage({ done: true }), 200);
});

agentAuthRoutes.post("/agent/identity/:id/revoke", async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId");
  if (!principalId) return c.json({ error: "unauthorized" }, 401);
  try {
    await revokeRegistration(
      ctx,
      principalId,
      c.req.param("id"),
      c.get("correlationId"),
    );
    return c.json({ status: "revoked" }, 200);
  } catch (err) {
    if (isAgentAuthError(err)) {
      return c.json(err.toJSON(), overlapCast(err.status));
    }
    throw err;
  }
});

agentAuthRoutes.post("/oauth2/token", async (c) => {
  const ctx = c.get("ctx");
  const form = await c.req.parseBody();
  const grantType = String(form.grant_type ?? "");
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  try {
    if (grantType === JWT_BEARER_GRANT) {
      const assertion = String(form.assertion ?? "");
      const resource =
        typeof form.resource === "string" ? form.resource : undefined;
      const scope = typeof form.scope === "string" ? form.scope : undefined;
      const result = await exchangeJwtBearer(
        ctx,
        assertion,
        resource,
        scope,
        c.get("correlationId"),
      );
      return c.json(result, 200);
    }
    if (grantType === AGENT_CLAIM_GRANT) {
      const claimToken = String(form.claim_token ?? "");
      const result = await pollClaimGrant(
        ctx,
        claimToken,
        c.get("correlationId"),
      );
      return c.json(result, 200);
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  } catch (err) {
    if (isAgentAuthError(err)) {
      return c.json(err.toJSON(), overlapCast(err.status));
    }
    throw err;
  }
});

agentAuthRoutes.post("/oauth2/revoke", async (c) => {
  const ctx = c.get("ctx");
  const form = await c.req.parseBody();
  const token = String(form.token ?? "");
  if (!token) {
    return c.json({ error: "invalid_request" }, 400);
  }
  await revokeAccessToken(ctx, token, c.get("correlationId"));
  return c.body(null, 200);
});

agentAuthRoutes.get("/v1/agent-resources/demo", async (c) => {
  const ctx = c.get("ctx");
  const auth = c.req.header("authorization");
  const token = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  const resolved = token ? await resolveAgentAccessToken(ctx, token) : null;
  if (!resolved) {
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${ctx.config.publicUrl}/.well-known/oauth-protected-resource"`,
    );
    return c.json({ error: "invalid_token" }, 401);
  }
  const needWrite = c.req.query("action") === "write";
  if (needWrite && !resolved.scopes.includes("resource:create:temporary")) {
    return c.json({ error: "insufficient_scope" }, 403);
  }
  return c.json({
    resource: "demo",
    claimed: resolved.claimed,
    scopes: resolved.scopes,
    registration_id: resolved.registration.id,
  });
});

agentAuthRoutes.get("/claim", async (c) => {
  const token = c.req.query("claim_attempt_token") ?? "";
  const principalId = c.get("principalId");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", AGENT_AUTH_CLAIM_CSP);
  if (!principalId) {
    const returnTo = `/claim?claim_attempt_token=${encodeURIComponent(token)}`;
    return c.redirect(`/login?return_to=${encodeURIComponent(returnTo)}`, 303);
  }
  return c.html(renderAgentAuthClaimPage({ claimAttemptToken: token }));
});

agentAuthRoutes.get("/login", async (c) => {
  const ctx = c.get("ctx");
  const returnTo = safeAgentAuthReturnTo(c.req.query("return_to") ?? "/claim");
  const principalId = c.get("principalId");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", AGENT_AUTH_CLAIM_CSP);
  if (principalId) {
    return c.redirect(returnTo, 303);
  }
  return c.html(
    renderAgentAuthLoginPage({
      returnTo,
      publicUrl: ctx.config.publicUrl,
    }),
  );
});
