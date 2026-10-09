import { randomUUID } from "node:crypto";
import type { Named } from "@gdp-ts/core";
import { appendAuditEvent } from "@opensesame/audit";
import {
  type CreateOAuthClientRequest,
  CreateOAuthClientRequestSchema,
  PatchOAuthClientRequestSchema,
} from "@opensesame/contracts";
import { canonicalSectorIdentifier } from "@opensesame/oauth-provider";
import { type OAuthClientRecord, overlapCast } from "@opensesame/os-domain";
import { type Context, Hono } from "hono";
import type { AppContext } from "../context.js";
import type { ActorId } from "../lib/ids.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import type { VerifiedPrincipal } from "../proofs/verified-principal.js";
import { serializeKeyed } from "../serialize.js";
import {
  insertOAuthClient,
  replaceOAuthClient,
} from "../services/verified-admin.js";
import { getUsage } from "../state.js";
import {
  confidentialClientCredentialsError,
  toDomain,
  toResponse,
  toStoreRecord,
} from "./oauth-client-map.js";
import {
  SECTOR_TAKEN,
  rotationRefusal,
  sectorClaimedByAnother,
  sectorControlRefusal,
  sectorTakenOrThrow,
} from "./oauth-client-sector.js";
import { authenticatedPrincipalId } from "./organizations.js";
import { asVerifiedPrincipal } from "./verified-principal-gate.js";

export const oauthClientRoutes = new Hono<{ Variables: Variables }>();

/**
 * Loads a client the caller owns. Foreign or unknown ids both answer 404 so the
 * endpoint is not an existence oracle for other principals' client registrations.
 */
async function loadOwnedClient(
  ctx: AppContext,
  principalId: string,
  id: string,
  { includeRevoked = false }: { includeRevoked?: boolean } = {},
): Promise<OAuthClientRecord | null> {
  const client = await ctx.stores.oauthClients.findById(id);
  if (!client) return null;
  if (client.ownerPrincipalId !== principalId) return null;
  if (!includeRevoked && client.state === "revoked") return null;
  return toDomain(client);
}

/** Client registration and mutation require a verified (non-provisional) identity. */
const refusal = (action: string) =>
  `Verified identity required to ${action} OAuth clients`;

/**
 * Registration spends a quota slot. Assurance says who someone is; it does not
 * say they may register clients forever, and without this the client store grew
 * for as long as a caller kept asking.
 */
async function assertRegistrationQuota(
  ctx: AppContext,
  principalId: string,
): Promise<Response | null> {
  const principal = await ctx.repos.principals.getById(principalId);
  if (!principal) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const decision = ctx.policy.evaluate(
    principal,
    {
      subject: {
        type: "principal",
        id: principal.id,
        assurance: principal.assurance,
      },
      action: "oauth.client.register",
      resource: { type: "oauth_client", id: "*" },
    },
    await getUsage(ctx.stores, principalId, ctx.clock()),
  );
  if (decision.effect === "deny") {
    return Response.json(
      { error: "forbidden", reasons: decision.reasons },
      { status: 403 },
    );
  }
  return null;
}

oauthClientRoutes.get("/", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const clients = (await ctx.stores.oauthClients.listByOwner(principalId))
    .filter((client) => client.state !== "revoked")
    .map(toDomain);
  return c.json({ clients: clients.map(toResponse) });
});

oauthClientRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("oauth-clients.create"),
  async (c) => {
    const ctx = c.get("ctx");
    const parsed = CreateOAuthClientRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    return asVerifiedPrincipal(
      c,
      refusal("register"),
      async ({ actor, proof }) => {
        // Sector control is proven before the lock: it may fetch a document.
        const unproven = await sectorControlRefusal(
          ctx,
          parsed.data.sectorIdentifier,
          parsed.data.redirectUris,
          parsed.data.sectorIdentifierUri,
        );
        if (unproven) return unproven;

        // ponytail: registration is low-volume; one lock also makes sector ownership
        // atomic. Split into durable principal/sector locks if registration throughput matters.
        return serializeKeyed(
          ctx.stores.principalMutations,
          "oauth-clients",
          () => registerClient(c, actor, proof, parsed.data),
        );
      },
    );
  },
);

/** The locked half of registration: quota, sector fence, insert, audit. */
async function registerClient<A>(
  c: Context<{ Variables: Variables }>,
  actor: Named<A, ActorId>,
  proof: VerifiedPrincipal<A>,
  data: CreateOAuthClientRequest,
) {
  const ctx = c.get("ctx");
  const principalId = actor.value;
  const overQuota = await assertRegistrationQuota(ctx, principalId);
  if (overQuota) return overQuota;

  const sectorIdentifier = canonicalSectorIdentifier(data.sectorIdentifier);
  if (data.admissionMode !== "pre_registered") {
    return c.json(
      {
        error: "admission_mode_disabled",
        message:
          "Only pre_registered clients may be created via this API; DCR/CIMD/origin profiles are feature-gated",
      },
      400,
    );
  }

  if (await sectorClaimedByAnother(ctx, principalId, sectorIdentifier)) {
    return c.json(SECTOR_TAKEN, 409);
  }

  const now = ctx.clock();
  const client: OAuthClientRecord = {
    id: `cli_${randomUUID()}`,
    ownerPrincipalId: principalId,
    admissionMode: "pre_registered",
    displayName: data.displayName,
    redirectUris: data.redirectUris,
    sectorIdentifier,
    grantTypes: data.grantTypes,
    responseTypes: data.responseTypes,
    tokenEndpointAuthMethod: data.tokenEndpointAuthMethod,
    allowedScopes: data.allowedScopes,
    allowedResources: data.allowedResources,
    ...(data.jwks ? { jwks: data.jwks } : undefined),
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
  const publicCc = confidentialClientCredentialsError(client);
  if (publicCc) {
    return c.json({ error: "invalid_client_auth", message: publicCc }, 400);
  }
  try {
    await insertOAuthClient(ctx, actor, proof, toStoreRecord(client));
  } catch (err) {
    return sectorTakenOrThrow(overlapCast(err));
  }

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
}

oauthClientRoutes.patch("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  return asVerifiedPrincipal(c, refusal("modify"), async ({ actor, proof }) => {
    const client = await loadOwnedClient(ctx, principalId, c.req.param("id"));
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
    const next: OAuthClientRecord = {
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
    if (parsed.data.grantTypes !== undefined) {
      next.grantTypes = parsed.data.grantTypes;
    }
    if (parsed.data.tokenEndpointAuthMethod !== undefined) {
      next.tokenEndpointAuthMethod = parsed.data.tokenEndpointAuthMethod;
    }
    if (parsed.data.state !== undefined) {
      next.state = parsed.data.state;
    }
    if (parsed.data.jwks !== undefined) {
      next.jwks = parsed.data.jwks;
    }
    const publicCc = confidentialClientCredentialsError(next);
    if (publicCc) {
      return c.json({ error: "invalid_client_auth", message: publicCc }, 400);
    }
    if (parsed.data.redirectUris !== undefined) {
      const unproven = await sectorControlRefusal(
        ctx,
        next.sectorIdentifier,
        next.redirectUris,
        parsed.data.sectorIdentifierUri,
      );
      if (unproven) return unproven;
    }
    await replaceOAuthClient(ctx, actor, proof, toStoreRecord(next));

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
});

oauthClientRoutes.post("/:id/rotate", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  return asVerifiedPrincipal(c, refusal("rotate"), async ({ actor, proof }) => {
    const client = await loadOwnedClient(ctx, principalId, c.req.param("id"));
    if (!client) {
      return c.json({ error: "not_found" }, 404);
    }
    const refused = await rotationRefusal(
      ctx,
      principalId,
      client.id,
      client.sectorIdentifier,
    );
    if (refused) return refused;
    const now = ctx.clock();
    const rotated: OAuthClientRecord = {
      ...client,
      id: `cli_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    };
    // The successor claims the sector before the old id retires, so a rotation
    // the claim refuses changes nothing. `successorOf` re-decides the pre-check
    // under the claim lock: a release that lands in between refuses it.
    try {
      await insertOAuthClient(ctx, actor, proof, toStoreRecord(rotated), {
        successorOf: client.id,
      });
    } catch (err) {
      return sectorTakenOrThrow(overlapCast(err));
    }
    await replaceOAuthClient(
      ctx,
      actor,
      proof,
      toStoreRecord({
        ...client,
        state: "revoked",
        updatedAt: now,
      }),
    );

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
});

oauthClientRoutes.post("/:id/revoke", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  return asVerifiedPrincipal(c, refusal("revoke"), async ({ actor, proof }) => {
    const client = await loadOwnedClient(ctx, principalId, c.req.param("id"), {
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
    await replaceOAuthClient(ctx, actor, proof, toStoreRecord(revoked));

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
});
