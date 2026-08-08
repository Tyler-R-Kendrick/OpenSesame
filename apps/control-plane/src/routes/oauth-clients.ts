import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { appendAuditEvent } from "@opensesame/audit";
import {
  CreateOAuthClientRequestSchema,
  OAuthClientResponseSchema,
  PatchOAuthClientRequestSchema,
} from "@opensesame/contracts";
import type { OAuthClientRecord } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import type { Variables } from "../middleware/context.js";
import { requirePrincipal } from "../middleware/auth.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";

export const oauthClientRoutes = new Hono<{ Variables: Variables }>();

function toResponse(client: OAuthClientRecord) {
  return OAuthClientResponseSchema.parse({
    id: client.id,
    ownerPrincipalId: client.ownerPrincipalId,
    admissionMode: client.admissionMode,
    displayName: client.displayName,
    redirectUris: client.redirectUris,
    sectorIdentifier: client.sectorIdentifier,
    grantTypes: client.grantTypes,
    responseTypes: client.responseTypes,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    allowedScopes: client.allowedScopes,
    allowedResources: client.allowedResources,
    state: client.state,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
  });
}

/**
 * Loads a client the caller owns. Foreign or unknown ids both answer 404 so the
 * endpoint is not an existence oracle for other principals' client registrations.
 */
function loadOwnedClient(
  ctx: AppContext,
  principalId: string,
  id: string,
  { includeRevoked = false }: { includeRevoked?: boolean } = {},
): OAuthClientRecord | null {
  const client = ctx.stores.oauthClients.get(id);
  if (!client) return null;
  if (client.ownerPrincipalId !== principalId) return null;
  if (!includeRevoked && client.state === "revoked") return null;
  return client;
}

/** Client registration and mutation require a verified (non-provisional) identity. */
async function assertVerified(
  ctx: AppContext,
  principalId: string,
  action: string,
): Promise<Response | null> {
  const principal = await ctx.repos.principals.getById(principalId);
  if (!principal) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (principal.assurance === "provisional") {
    return Response.json(
      {
        error: "assurance_too_low",
        message: `Verified identity required to ${action} OAuth clients`,
      },
      { status: 403 },
    );
  }
  return null;
}

oauthClientRoutes.get("/", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const clients = [...ctx.stores.oauthClients.values()].filter(
    (client) => client.ownerPrincipalId === principalId && client.state !== "revoked",
  );
  return c.json({ clients: clients.map(toResponse) });
});

oauthClientRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("oauth-clients.create"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = c.get("principalId")!;
    const denied = await assertVerified(ctx, principalId, "register");
    if (denied) return denied;

    const parsed = CreateOAuthClientRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    if (parsed.data.admissionMode !== "pre_registered") {
      return c.json(
        {
          error: "admission_mode_disabled",
          message:
            "Only pre_registered clients may be created via this API; DCR/CIMD/origin profiles are feature-gated",
        },
        400,
      );
    }

    const now = ctx.clock();
    const client: OAuthClientRecord = {
      id: `cli_${randomUUID()}`,
      ownerPrincipalId: principalId,
      admissionMode: "pre_registered",
      displayName: parsed.data.displayName,
      redirectUris: parsed.data.redirectUris,
      sectorIdentifier: parsed.data.sectorIdentifier,
      grantTypes: parsed.data.grantTypes,
      responseTypes: parsed.data.responseTypes,
      tokenEndpointAuthMethod: parsed.data.tokenEndpointAuthMethod,
      allowedScopes: parsed.data.allowedScopes,
      allowedResources: parsed.data.allowedResources,
      state: "active",
      createdAt: now,
      updatedAt: now,
    };
    ctx.stores.oauthClients.set(client.id, client);

    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "oauth_client.created",
      outcome: "succeeded",
      principalId,
      clientId: client.id,
      correlationId: c.get("correlationId"),
      metadata: {
        action: "oauth_client.create",
        admissionMode: client.admissionMode,
        sectorIdentifier: client.sectorIdentifier,
      },
    });

    return c.json(toResponse(client), 201);
  },
);

oauthClientRoutes.patch("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const denied = await assertVerified(ctx, principalId, "modify");
  if (denied) return denied;
  const client = loadOwnedClient(ctx, principalId, c.req.param("id"));
  if (!client) {
    return c.json({ error: "not_found" }, 404);
  }

  const parsed = PatchOAuthClientRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", details: parsed.error.flatten() },
      400,
    );
  }

  const now = ctx.clock();
  let next: OAuthClientRecord = {
    ...client,
    updatedAt: now,
  };
  if (parsed.data.displayName !== undefined) {
    next.displayName = parsed.data.displayName;
  }
  if (parsed.data.redirectUris !== undefined) {
    next.redirectUris = parsed.data.redirectUris;
  }
  if (parsed.data.allowedScopes !== undefined) {
    next.allowedScopes = parsed.data.allowedScopes;
  }
  if (parsed.data.allowedResources !== undefined) {
    next.allowedResources = parsed.data.allowedResources;
  }
  if (parsed.data.state !== undefined) {
    next.state = parsed.data.state;
  }
  ctx.stores.oauthClients.set(next.id, next);

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "oauth_client.updated",
    outcome: "succeeded",
    principalId,
    clientId: next.id,
    correlationId: c.get("correlationId"),
    metadata: { action: "oauth_client.patch" },
  });

  return c.json(toResponse(next));
});

oauthClientRoutes.post("/:id/rotate", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const denied = await assertVerified(ctx, principalId, "rotate");
  if (denied) return denied;
  const client = loadOwnedClient(ctx, principalId, c.req.param("id"));
  if (!client) {
    return c.json({ error: "not_found" }, 404);
  }
  const now = ctx.clock();
  const rotated: OAuthClientRecord = {
    ...client,
    id: `cli_${randomUUID()}`,
    createdAt: now,
    updatedAt: now,
  };
  ctx.stores.oauthClients.set(client.id, {
    ...client,
    state: "revoked",
    updatedAt: now,
  });
  ctx.stores.oauthClients.set(rotated.id, rotated);

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "oauth_client.rotated",
    outcome: "succeeded",
    principalId,
    clientId: rotated.id,
    correlationId: c.get("correlationId"),
    metadata: {
      action: "oauth_client.rotate",
      previousClientId: client.id,
    },
  });

  return c.json(toResponse(rotated), 201);
});

oauthClientRoutes.post("/:id/revoke", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const denied = await assertVerified(ctx, principalId, "revoke");
  if (denied) return denied;
  const client = loadOwnedClient(ctx, principalId, c.req.param("id"), {
    includeRevoked: true,
  });
  if (!client) {
    return c.json({ error: "not_found" }, 404);
  }
  const now = ctx.clock();
  const revoked: OAuthClientRecord = {
    ...client,
    state: "revoked",
    updatedAt: now,
  };
  ctx.stores.oauthClients.set(revoked.id, revoked);

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "oauth_client.revoked",
    outcome: "succeeded",
    principalId,
    clientId: revoked.id,
    correlationId: c.get("correlationId"),
    metadata: { action: "oauth_client.revoke" },
  });

  return c.json(toResponse(revoked));
});
