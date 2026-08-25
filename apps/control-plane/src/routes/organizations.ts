import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  AddOrganizationMemberRequestSchema,
  ChangeOrganizationMemberRoleRequestSchema,
  CreateOrganizationRequestSchema,
  JoinOrganizationTenantRequestSchema,
  type OrganizationAuthMethod,
  OrganizationMembershipResponseSchema,
  OrganizationResponseSchema,
  OrganizationTenantResponseSchema,
  UpdateOrganizationRequestSchema,
} from "@opensesame/contracts";
import {
  UnsafeMetadataUrlError,
  assertSafeMetadataUrl,
} from "@opensesame/oauth-provider";
import type {
  Organization,
  OrganizationMembership,
  OrganizationRole,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { serializeKeyed } from "../serialize.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import { getUsage } from "../state.js";
import {
  OrgAssertionError,
  type VerifiedOrgIdToken,
  originAudiences,
  verifyOrgIdToken,
} from "./org-assertion.js";
// One direction of a deliberate cycle: SCIM is per-organization, so its router
// reuses this module's membership helpers, and this module asks it what role a
// provisioned subject joins at. Both are functions called per request, never at
// module load.
import { provisionedRoleForSubject } from "./scim.js";

export const organizationRoutes = new Hono<{ Variables: Variables }>();

/**
 * How stale an organization assertion may be at the join route (ADR 0055).
 *
 * The browser leg deliberately sends no nonce — the code + PKCE exchange binds
 * it — so replay is fenced by three other things instead: the audience must be
 * one of our own surfaces, the subject is bound to the caller, and the token
 * must be minutes old. Ten minutes is the same window the interactive
 * federated round-trip gets.
 */
const JOIN_MAX_TOKEN_AGE_SECONDS = 600;

export function authenticatedPrincipalId(value: string | undefined): string {
  if (!value) throw new Error("requirePrincipal middleware invariant violated");
  return value;
}

export async function ensurePersonalOrganization(
  ctx: AppContext,
  principalId: string,
): Promise<OrganizationMembership> {
  const [existing] =
    await ctx.stores.organizationMemberships.listByPrincipal(principalId);
  if (existing) return existing;

  const now = ctx.clock();
  const organization: Organization = {
    id: `org:${randomUUID()}`,
    slug: `local-${randomUUID().slice(0, 8)}`,
    displayName: "Personal workspace",
    state: "active",
    createdBy: principalId,
    createdAt: now,
    updatedAt: now,
  };
  const membership: OrganizationMembership = {
    organizationId: organization.id,
    principalId,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  };
  await ctx.stores.organizations.set(organization.id, organization);
  return ctx.stores.organizationMemberships.upsert(membership);
}

export function hostApiEndpoint(
  configuredUrl: string,
  path: string,
): URL | undefined {
  try {
    const base = new URL(configuredUrl);
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      base.username ||
      base.password
    ) {
      return undefined;
    }
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return new URL(path.replace(/^\/+/, ""), base);
  } catch {
    return undefined;
  }
}

function toResponse(org: Organization, role: OrganizationRole) {
  return OrganizationResponseSchema.parse({
    id: org.id,
    slug: org.slug,
    displayName: org.displayName,
    state: org.state,
    role,
    createdBy: org.createdBy,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
    ...(org.ssoIssuer ? { ssoIssuer: org.ssoIssuer } : undefined),
    ...(org.ssoClientId ? { ssoClientId: org.ssoClientId } : undefined),
    // The secret is write-only: it must reach the tenant's token endpoint as
    // issued, so there is no digest to show and nothing a caller could use.
    ...(org.ssoClientSecret ? { ssoClientSecretConfigured: true } : undefined),
    ...(org.samlIssuer ? { samlIssuer: org.samlIssuer } : undefined),
    ...(org.samlMetadataUrl
      ? { samlMetadataUrl: org.samlMetadataUrl }
      : undefined),
    // The document itself never leaves the server: it is multi-KB of IdP XML
    // and an API caller only needs to know whether one is configured.
    ...(org.samlMetadataXml ? { samlMetadataConfigured: true } : undefined),
    ...(org.provisioningEnabled ? { provisioningEnabled: true } : undefined),
  });
}

/** True when the tenant configured a real SAML IdP rather than a broker. */
export function usesNativeSaml(org: Organization): boolean {
  return Boolean(org.samlMetadataUrl || org.samlMetadataXml);
}

/**
 * The sign-in methods a tenant offers, as the public tenant endpoint and the
 * hosted login page both render them.
 *
 * The two SAML shapes are deliberately distinguishable (ADR 0056): with
 * metadata configured the method is native SAML and runs entirely server-side
 * through the hosted login page, so no browser-side issuer is offered at all.
 * Without metadata `samlIssuer` keeps its ADR 0016 meaning — the OIDC issuer
 * of a SAML-brokering Keycloak — and stays a normal brokered redirect.
 */
export async function tenantAuthMethods(
  ctx: AppContext,
  org: Organization,
): Promise<OrganizationAuthMethod[]> {
  const methods: OrganizationAuthMethod[] = [];
  if (org.ssoIssuer) {
    methods.push({ kind: "sso", label: "SSO", issuer: org.ssoIssuer });
  }
  if (usesNativeSaml(org)) {
    methods.push({ kind: "saml", label: "SAML", native: true });
  } else if (org.samlIssuer) {
    methods.push({ kind: "saml", label: "SAML", issuer: org.samlIssuer });
  }
  // The LDAP leg itself belongs to the login page (a first-party username and
  // password form); this is the advertisement that the tenant has one.
  const ldap = await ctx.stores.orgFederation.ldapConfigs.get(org.id);
  if (ldap) methods.push({ kind: "ldap", label: "Directory" });
  return methods;
}

async function orgBySlug(
  ctx: AppContext,
  slug: string,
): Promise<Organization | undefined> {
  const org = await ctx.stores.organizations.getBySlug(slug);
  if (!org || org.state === "deleted" || org.state === "suspended") {
    return undefined;
  }
  return org;
}

/**
 * The OIDC issuer an id_token join may be asserted against.
 *
 * Native SAML has none — its assertions arrive at the ACS as signed XML, not
 * as a bearer id_token — and neither does LDAP, so both answer `undefined` and
 * the route refuses the method rather than verifying against an entityID.
 */
function issuerForMethod(
  org: Organization,
  method: "sso" | "saml" | "ldap",
): string | undefined {
  if (method === "sso") return org.ssoIssuer;
  if (method === "ldap") return undefined;
  return usesNativeSaml(org) ? undefined : org.samlIssuer;
}

function membershipResponse(membership: OrganizationMembership) {
  return OrganizationMembershipResponseSchema.parse({
    ...membership,
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
  });
}

async function getMembership(
  ctx: AppContext,
  organizationId: string,
  principalId: string,
): Promise<OrganizationMembership | undefined> {
  return ctx.stores.organizationMemberships.find(organizationId, principalId);
}

export async function serializeMembershipMutation<T>(
  ctx: AppContext,
  organizationId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous =
    ctx.stores.organizationMembershipMutations.get(organizationId) ??
    Promise.resolve();
  let release = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  ctx.stores.organizationMembershipMutations.set(organizationId, tail);
  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (
      ctx.stores.organizationMembershipMutations.get(organizationId) === tail
    ) {
      ctx.stores.organizationMembershipMutations.delete(organizationId);
    }
  }
}

export type JitJoinInput = {
  organization: Organization;
  principalId: string;
  /** The upstream subject that authenticated this sign-in. */
  subject: string;
  /** How the subject authenticated — recorded on the audit row. */
  method: string;
  correlationId: string;
  role?: OrganizationRole;
};

export type JitJoinResult =
  | { ok: true; membership: OrganizationMembership; created: boolean }
  | { ok: false; error: "not_provisioned"; message: string };

/**
 * Join an authenticated subject to a tenant (ADR 0055/0056).
 *
 * Shared deliberately: the tenant join route and the hosted login page's
 * completion path must agree on membership and on what the trail records, or
 * where you signed in decides whether you are a member. When the tenant marks
 * SCIM authoritative, the directory — not the IdP — decides: a subject with no
 * active provisioned row is refused even though its assertion verified, which
 * is the whole point of directory-driven deprovisioning.
 */
export async function jitJoinOrganization(
  ctx: AppContext,
  input: JitJoinInput,
): Promise<JitJoinResult> {
  const org = input.organization;
  if (org.provisioningEnabled) {
    const provisioned = await ctx.stores.scim.users.findBySubject(
      org.id,
      input.subject,
    );
    if (!provisioned?.active) {
      return {
        ok: false,
        error: "not_provisioned",
        message: "This organization provisions members through its directory.",
      };
    }
  }

  return serializeMembershipMutation(ctx, org.id, async () => {
    const existing = await getMembership(ctx, org.id, input.principalId);
    if (existing)
      return { ok: true as const, membership: existing, created: false };

    const now = ctx.clock();
    const membership = await ctx.stores.organizationMemberships.upsert({
      organizationId: org.id,
      principalId: input.principalId,
      role: input.role ?? "member",
      createdAt: now,
      updatedAt: now,
    });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.member_joined",
      outcome: "succeeded",
      principalId: input.principalId,
      organizationId: org.id,
      correlationId: input.correlationId,
      metadata: {
        action: "organization.tenant.join",
        method: input.method,
      },
    });
    return { ok: true as const, membership, created: true };
  });
}

export type OrganizationRevocationInput = {
  organizationId: string;
  principalId: string;
  correlationId: string;
  /** Why authority was withdrawn — recorded on the audit row. */
  reason: string;
};

export type OrganizationRevocationResult = {
  /** False when the membership was already gone (a repeated sync pass). */
  membershipRemoved: boolean;
  sessionsRevoked: number;
};

/**
 * Drop a membership and every session it authorized (ADR 0056/0057).
 *
 * SCIM deactivation and an LDAP directory sync both have to do exactly this,
 * and a deprovisioning that removed the row but left live provisional bearers
 * behind would leave the user signed in for the rest of the session TTL.
 */
export async function revokeOrganizationMembership(
  ctx: AppContext,
  input: OrganizationRevocationInput,
): Promise<OrganizationRevocationResult> {
  const membershipRemoved = await serializeMembershipMutation(
    ctx,
    input.organizationId,
    async () =>
      ctx.stores.organizationMemberships.remove(
        input.organizationId,
        input.principalId,
      ),
  );

  let sessionsRevoked = 0;
  for (const [id, session] of ctx.stores.provisionalSessions) {
    if (session.principalId !== input.principalId) continue;
    ctx.stores.provisionalSessions.delete(id);
    sessionsRevoked += 1;
  }
  for (const [token, sessionId] of ctx.stores.provisionalTokens) {
    if (!ctx.stores.provisionalSessions.has(sessionId)) {
      ctx.stores.provisionalTokens.delete(token);
    }
  }

  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "organization.member_revoked",
    outcome: "succeeded",
    principalId: input.principalId,
    organizationId: input.organizationId,
    correlationId: input.correlationId,
    metadata: {
      action: "organization.member.revoke",
      reason: input.reason,
      count: sessionsRevoked,
    },
  });
  return { membershipRemoved, sessionsRevoked };
}

/**
 * Refuse an issuer this deployment must not dereference (T21).
 *
 * The submitted value ends up as a server-side discovery fetch, so an owner
 * who could point it at `169.254.169.254` would have turned the org surface
 * into an SSRF gadget. Loopback stays reachable under dev defaults because
 * that is where the reference IdP and the local Keycloak run.
 */
function issuerConfigurationError(
  ctx: AppContext,
  value: string | null | undefined,
): string | undefined {
  if (!value || ctx.config.allowDevDefaults) return undefined;
  try {
    assertSafeMetadataUrl(value);
    return undefined;
  } catch (error) {
    if (error instanceof UnsafeMetadataUrlError) return error.message;
    throw error;
  }
}

async function revokeHostSessions(
  ctx: AppContext,
  organizationId: string,
  principalId: string,
): Promise<boolean> {
  const url = hostApiEndpoint(ctx.config.hostApiUrl, "api/v1/sessions/revoke");
  if (!url) return false;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opensesame-operator": ctx.config.operatorToken,
      },
      body: JSON.stringify({
        organization_id: organizationId,
        principal_id: principalId,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch (error) {
    ctx.log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Host session revocation failed",
    );
    return false;
  }
}

organizationRoutes.get("/", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const organizations = [];
  for (const membership of await ctx.stores.organizationMemberships.listByPrincipal(
    principalId,
  )) {
    const org = await ctx.stores.organizations.get(membership.organizationId);
    if (!org || org.state === "deleted") continue;
    organizations.push(toResponse(org, membership.role));
  }
  return c.json({ organizations });
});

organizationRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("organizations.create"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const principal = await ctx.repos.principals.getById(principalId);
    if (!principal) {
      return c.json({ error: "not_found" }, 404);
    }
    if (principal.assurance === "provisional") {
      return c.json(
        {
          error: "assurance_too_low",
          message: "Verified identity required to create an organization",
        },
        403,
      );
    }

    const parsed = CreateOrganizationRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const unsafeIssuer =
      issuerConfigurationError(ctx, parsed.data.ssoIssuer) ??
      issuerConfigurationError(ctx, parsed.data.samlIssuer);
    if (unsafeIssuer) {
      return c.json({ error: "unsafe_issuer", message: unsafeIssuer }, 400);
    }

    return serializeKeyed(
      ctx.stores.principalMutations,
      principalId,
      async () => {
        const decision = ctx.policy.evaluate(
          principal,
          {
            subject: {
              type: "principal",
              id: principal.id,
              assurance: principal.assurance,
            },
            action: "organization.create",
            resource: { type: "organization", id: "*" },
          },
          await getUsage(ctx.stores, principalId, ctx.clock()),
        );
        if (decision.effect === "deny") {
          return c.json({ error: "forbidden", reasons: decision.reasons }, 403);
        }

        if (await ctx.stores.organizations.getBySlug(parsed.data.slug)) {
          return c.json({ error: "slug_taken" }, 409);
        }

        const now = ctx.clock();
        const org: Organization = {
          // Rust Host APIs use the canonical opaque-id spelling `org:<uuid>`.
          id: `org:${randomUUID()}`,
          slug: parsed.data.slug,
          displayName: parsed.data.displayName,
          state: "active",
          createdBy: principalId,
          createdAt: now,
          updatedAt: now,
        };
        if (parsed.data.ssoIssuer) org.ssoIssuer = parsed.data.ssoIssuer;
        if (parsed.data.samlIssuer) org.samlIssuer = parsed.data.samlIssuer;
        await ctx.stores.organizations.set(org.id, org);
        await ctx.stores.organizationMemberships.upsert({
          organizationId: org.id,
          principalId,
          role: "owner",
          createdAt: now,
          updatedAt: now,
        });

        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "organization.created",
          outcome: "succeeded",
          principalId,
          organizationId: org.id,
          correlationId: c.get("correlationId"),
          metadata: { action: "organization.create", slug: org.slug },
        });

        return c.json(toResponse(org, "owner"), 201);
      },
    );
  },
);

organizationRoutes.get("/tenants/:slug", async (c) => {
  const ctx = c.get("ctx");
  const org = await orgBySlug(ctx, c.req.param("slug"));
  if (!org) return c.json({ error: "not_found" }, 404);
  return c.json(
    OrganizationTenantResponseSchema.parse({
      slug: org.slug,
      displayName: org.displayName,
      state: org.state,
      authMethods: await tenantAuthMethods(ctx, org),
    }),
  );
});

/**
 * Join a tenant with an assertion the caller obtained from its IdP.
 *
 * The id_token POST is kept (a forced code flow here would break the working
 * browser leg in Pages), but it is now fenced on all three axes it was missing
 * (ADR 0055): the token must have been minted for one of our own surfaces,
 * it must be minutes old, and the subject it names is bound to the calling
 * principal — so an assertion for somebody else's identity cannot buy
 * membership, and a subject already bound elsewhere is a conflict rather than
 * a silent second home.
 */
organizationRoutes.post(
  "/tenants/:slug/join",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const org = await orgBySlug(ctx, c.req.param("slug"));
    if (!org) return c.json({ error: "not_found" }, 404);

    const parsed = JoinOrganizationTenantRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    const issuer = issuerForMethod(org, parsed.data.method);
    if (!issuer) {
      return c.json({ error: "auth_method_unavailable" }, 409);
    }

    let assertion: VerifiedOrgIdToken;
    try {
      assertion = await verifyOrgIdToken(parsed.data.idToken, issuer, {
        expectedAudiences: originAudiences(ctx.config),
        maxTokenAgeSec: JOIN_MAX_TOKEN_AGE_SECONDS,
        blockPrivateIssuerHosts: !ctx.config.allowDevDefaults,
      });
    } catch (error) {
      if (error instanceof OrgAssertionError) {
        const status = error.code === "upstream_unavailable" ? 502 : 401;
        return c.json({ error: error.code, message: error.message }, status);
      }
      throw error;
    }

    // Bind the asserted subject to the caller before anything is granted. A
    // collision means the identity belongs to a different principal; the
    // message deliberately does not name it (federated-signin.md §7.6).
    const attached = await attachVerifiedExternalIdentity(ctx, principalId, {
      issuer,
      subject: assertion.sub,
      correlationId: c.get("correlationId"),
      ...(assertion.name !== undefined
        ? { displayHint: assertion.name }
        : undefined),
      ...(assertion.email !== undefined
        ? { emailNormalized: assertion.email }
        : undefined),
      ...(assertion.emailVerified !== undefined
        ? { emailVerified: assertion.emailVerified }
        : undefined),
    });
    if (!attached.ok) {
      return c.json({ error: attached.error, message: attached.message }, 409);
    }

    // A subject the directory provisioned into a role joins at that role, not
    // at `member` (C15) — the same answer this tenant's hosted sign-in gives.
    const role = await provisionedRoleForSubject(ctx, org.id, assertion.sub);
    const joined = await jitJoinOrganization(ctx, {
      organization: org,
      principalId,
      subject: assertion.sub,
      method: parsed.data.method,
      correlationId: c.get("correlationId"),
      ...(role !== undefined ? { role } : undefined),
    });
    if (!joined.ok) {
      return c.json({ error: joined.error, message: joined.message }, 403);
    }
    return joined.created
      ? c.json(toResponse(org, joined.membership.role), 201)
      : c.json(toResponse(org, joined.membership.role));
  },
);

organizationRoutes.patch("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const org = await ctx.stores.organizations.get(c.req.param("id"));
  const membership = org && (await getMembership(ctx, org.id, principalId));
  if (!org || org.state === "deleted" || !membership) {
    return c.json({ error: "not_found" }, 404);
  }
  if (membership.role !== "owner") {
    return c.json({ error: "owner_required" }, 403);
  }
  const parsed = UpdateOrganizationRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", details: parsed.error.flatten() },
      400,
    );
  }
  const unsafeIssuer =
    issuerConfigurationError(ctx, parsed.data.ssoIssuer) ??
    issuerConfigurationError(ctx, parsed.data.samlIssuer) ??
    issuerConfigurationError(ctx, parsed.data.samlMetadataUrl);
  if (unsafeIssuer) {
    return c.json({ error: "unsafe_issuer", message: unsafeIssuer }, 400);
  }

  const patch = <T>(submitted: T | null | undefined, current: T | undefined) =>
    submitted === undefined ? current : (submitted ?? undefined);
  const ssoIssuer = patch(parsed.data.ssoIssuer, org.ssoIssuer);
  const ssoClientId = patch(parsed.data.ssoClientId, org.ssoClientId);
  const ssoClientSecret = patch(
    parsed.data.ssoClientSecret,
    org.ssoClientSecret,
  );
  const samlIssuer = patch(parsed.data.samlIssuer, org.samlIssuer);
  const samlMetadataUrl = patch(
    parsed.data.samlMetadataUrl,
    org.samlMetadataUrl,
  );
  const samlMetadataXml = patch(
    parsed.data.samlMetadataXml,
    org.samlMetadataXml,
  );
  // Exactly one metadata source may survive the merge, or a later fetch has no
  // deterministic answer to "which document describes this IdP".
  if (samlMetadataUrl && samlMetadataXml) {
    return c.json(
      {
        error: "validation_error",
        message: "samlMetadataUrl and samlMetadataXml are mutually exclusive",
      },
      400,
    );
  }
  const updated: Organization = {
    id: org.id,
    slug: org.slug,
    displayName: parsed.data.displayName ?? org.displayName,
    state: org.state,
    createdBy: org.createdBy,
    createdAt: org.createdAt,
    updatedAt: ctx.clock(),
  };
  if (ssoIssuer) updated.ssoIssuer = ssoIssuer;
  // Credentials only mean anything alongside the issuer they were issued at,
  // so clearing `ssoIssuer` drops them rather than leaving one tenant's client
  // id to be presented at whatever issuer is configured next.
  if (ssoIssuer && ssoClientId) updated.ssoClientId = ssoClientId;
  if (ssoIssuer && ssoClientId && ssoClientSecret) {
    updated.ssoClientSecret = ssoClientSecret;
  }
  if (samlIssuer) updated.samlIssuer = samlIssuer;
  if (samlMetadataUrl) updated.samlMetadataUrl = samlMetadataUrl;
  if (samlMetadataXml) updated.samlMetadataXml = samlMetadataXml;
  const provisioningEnabled =
    parsed.data.provisioningEnabled ?? org.provisioningEnabled;
  if (provisioningEnabled) updated.provisioningEnabled = true;
  await ctx.stores.organizations.set(org.id, updated);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "organization.updated",
    outcome: "succeeded",
    principalId,
    organizationId: org.id,
    correlationId: c.get("correlationId"),
    metadata: { action: "organization.update" },
  });
  return c.json(toResponse(updated, membership.role));
});

organizationRoutes.get("/:id/members", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const organizationId = c.req.param("id");
  const membership = await getMembership(ctx, organizationId, principalId);
  if (!membership) return c.json({ error: "not_found" }, 404);
  if (membership.role !== "owner") {
    return c.json({ error: "owner_required" }, 403);
  }
  const members = (
    await ctx.stores.organizationMemberships.listByOrganization(organizationId)
  ).map(membershipResponse);
  return c.json({ members });
});

organizationRoutes.post("/:id/members", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const organizationId = c.req.param("id");
  return serializeMembershipMutation(ctx, organizationId, async () => {
    const actor = await getMembership(ctx, organizationId, principalId);
    if (!actor) return c.json({ error: "not_found" }, 404);
    if (actor.role !== "owner") {
      return c.json({ error: "owner_required" }, 403);
    }
    const parsed = AddOrganizationMemberRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const principal = await ctx.repos.principals.getById(
      parsed.data.principalId,
    );
    if (!principal) return c.json({ error: "principal_not_found" }, 404);
    if (principal.state === "suspended" || principal.state === "closed") {
      return c.json({ error: "principal_inactive" }, 409);
    }
    if (await getMembership(ctx, organizationId, principal.id)) {
      return c.json({ error: "membership_exists" }, 409);
    }
    const now = ctx.clock();
    const membership = await ctx.stores.organizationMemberships.upsert({
      organizationId,
      principalId: principal.id,
      role: parsed.data.role,
      createdAt: now,
      updatedAt: now,
    });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.member_added",
      outcome: "succeeded",
      principalId,
      organizationId,
      correlationId: c.get("correlationId"),
      metadata: {
        action: "organization.member.add",
        memberPrincipalId: principal.id,
        role: membership.role,
      },
    });
    return c.json(membershipResponse(membership), 201);
  });
});

organizationRoutes.patch(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const actorPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const organizationId = c.req.param("id");
    return serializeMembershipMutation(ctx, organizationId, async () => {
      const actor = await getMembership(ctx, organizationId, actorPrincipalId);
      if (!actor) return c.json({ error: "not_found" }, 404);
      if (actor.role !== "owner") {
        return c.json({ error: "owner_required" }, 403);
      }
      const targetPrincipalId = c.req.param("principalId");
      const target = await getMembership(
        ctx,
        organizationId,
        targetPrincipalId,
      );
      if (!target) return c.json({ error: "membership_not_found" }, 404);
      const parsed = ChangeOrganizationMemberRoleRequestSchema.safeParse(
        await c.req.json(),
      );
      if (!parsed.success) {
        return c.json(
          { error: "validation_error", details: parsed.error.flatten() },
          400,
        );
      }
      if (target.role === parsed.data.role) {
        return c.json(membershipResponse(target));
      }
      if (
        target.role === "owner" &&
        (await ctx.stores.organizationMemberships.countOwners(
          organizationId,
        )) === 1
      ) {
        return c.json({ error: "last_owner" }, 409);
      }
      const updated: OrganizationMembership = {
        ...target,
        role: parsed.data.role,
        updatedAt: ctx.clock(),
      };
      // Publish the new role before yielding to Host revocation. Otherwise a
      // concurrent approval can capture the old role after Host has revoked it.
      await ctx.stores.organizationMemberships.upsert(updated);
      if (!(await revokeHostSessions(ctx, organizationId, targetPrincipalId))) {
        await ctx.stores.organizationMemberships.upsert(target);
        return c.json({ error: "session_revocation_failed" }, 502);
      }
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.member_role_changed",
        outcome: "succeeded",
        principalId: actorPrincipalId,
        organizationId,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "organization.member.role.change",
          memberPrincipalId: targetPrincipalId,
          previousRole: target.role,
          role: updated.role,
        },
      });
      return c.json(membershipResponse(updated));
    });
  },
);

organizationRoutes.delete(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const actorPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const organizationId = c.req.param("id");
    return serializeMembershipMutation(ctx, organizationId, async () => {
      const actor = await getMembership(ctx, organizationId, actorPrincipalId);
      if (!actor) return c.json({ error: "not_found" }, 404);
      if (actor.role !== "owner") {
        return c.json({ error: "owner_required" }, 403);
      }
      const targetPrincipalId = c.req.param("principalId");
      const target = await getMembership(
        ctx,
        organizationId,
        targetPrincipalId,
      );
      if (!target) return c.json({ error: "membership_not_found" }, 404);
      if (
        target.role === "owner" &&
        (await ctx.stores.organizationMemberships.countOwners(
          organizationId,
        )) === 1
      ) {
        return c.json({ error: "last_owner" }, 409);
      }
      // Remove authority before yielding so no approval can mint a session in the
      // gap between revocation and this mutation. Restore it if Host fails closed.
      await ctx.stores.organizationMemberships.remove(
        organizationId,
        targetPrincipalId,
      );
      if (!(await revokeHostSessions(ctx, organizationId, targetPrincipalId))) {
        await ctx.stores.organizationMemberships.upsert(target);
        return c.json({ error: "session_revocation_failed" }, 502);
      }
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.member_removed",
        outcome: "succeeded",
        principalId: actorPrincipalId,
        organizationId,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "organization.member.remove",
          memberPrincipalId: targetPrincipalId,
          role: target.role,
        },
      });
      return c.body(null, 204);
    });
  },
);

organizationRoutes.get("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const org = await ctx.stores.organizations.get(c.req.param("id"));
  const membership = org && (await getMembership(ctx, org.id, principalId));
  if (!org || org.state === "deleted" || !membership) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(toResponse(org, membership.role));
});
