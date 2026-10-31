import { createHash, randomUUID } from "node:crypto";
import { name } from "@gdp-ts/core";
import { appendAuditEvent } from "@opensesame/audit";
import {
  AddOrganizationMemberRequestSchema,
  ChangeOrganizationMemberRoleRequestSchema,
  CreateOrganizationRequestSchema,
  JoinOrganizationTenantRequestSchema,
  OrganizationMembershipResponseSchema,
  OrganizationResponseSchema,
  OrganizationTenantResponseSchema,
  UpdateOrganizationRequestSchema,
} from "@opensesame/contracts";
import type {
  Organization,
  OrganizationMembership,
  OrganizationRole,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { secureServiceEndpoint } from "../deployment-mode.js";
import { organizationId } from "../lib/ids.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { organizationIssuerAdmission } from "../proofs/organization-issuer-admission.js";
import { serializeKeyed } from "../serialize.js";
import { emailLinkFields } from "../services/email-authority.js";
import { attachVerifiedExternalIdentity } from "../services/identity-link.js";
import {
  removeOrganizationMembership,
  writeOrganization,
  writeOrganizationMembership,
} from "../services/org-admin.js";
import {
  OrganizationIssuerApprovalError,
  issuerClaimed,
  verifyAdmittedOrganizationAssertion,
} from "../services/org-issuer-approval.js";
import { createOrganization } from "../services/verified-admin.js";
import { getUsage } from "../state.js";
import { OrgAssertionError, type VerifiedOrgIdToken } from "./org-assertion.js";
import { issuerForMethod, tenantAuthMethods } from "./org-auth-methods.js";
export { usesNativeSaml, tenantAuthMethods } from "./org-auth-methods.js";
import { normalizeEmailDomain } from "./org-domains.js";
import { organizationIssuerErrorHandler } from "./org-issuer-errors.js";
import {
  issuerConfigurationError,
  samlConfigurationError,
} from "./org-issuer-guard.js";
import { type OrgOwnerSource, asOrgOwner } from "./org-owner-gate.js";
// One direction of a deliberate cycle: SCIM is per-organization, so its router
// reuses this module's membership helpers, and this module asks it what role a
// provisioned subject joins at. Both are functions called per request, never at
// module load.
import {
  getMembership,
  jitJoinOrganization,
  serializeMembershipMutation,
} from "./organization-membership.js";
import { provisionedRoleForSubject } from "./scim.js";
import { asVerifiedPrincipal } from "./verified-principal-gate.js";

export {
  jitJoinOrganization,
  serializeMembershipMutation,
} from "./organization-membership.js";
export type { JitJoinInput, JitJoinResult } from "./organization-membership.js";

export const organizationRoutes = new Hono<{ Variables: Variables }>();
organizationRoutes.onError(organizationIssuerErrorHandler);

/**
 * The member routes have never read the organization's state, only the
 * caller's membership, so an owner of a deleted organization still reaches
 * them. Recorded as `unchecked` instead of quietly changed (ADR 0178).
 */
const MEMBER_ADMIN: OrgOwnerSource = { param: "id", liveness: "unchecked" };

/**
 * The public tenant lookup is unauthenticated and does a durable read plus an
 * LDAP-configuration read. A budget keeps one caller from turning that into a
 * database load generator; the global bucket is the ceiling a spoofed
 * fingerprint cannot rotate away from.
 */
const TENANT_LOOKUP_WINDOW_MS = 60_000;
const TENANT_LOOKUP_PER_CLIENT = 120;
const TENANT_LOOKUP_GLOBAL = 1_000;
const TENANT_LOOKUP_MAX_KEYS = 2_048;
const TENANT_LOOKUP_GLOBAL_KEY = "__global__";
const tenantLookupAttempts = new Map<string, number[]>();

/**
 * The tenant-join route performs an OIDC discovery + JWKS fetch on its first
 * request for an issuer. A provisional principal can reach it, so bound it per
 * principal and deployment-wide before any network work.
 */
const JOIN_WINDOW_MS = 60_000;
const JOIN_PER_PRINCIPAL = 10;
const JOIN_GLOBAL = 300;
const JOIN_MAX_KEYS = 2_048;
const joinAttempts = new Map<string, number[]>();

export function resetTenantJoinBudget(): void {
  joinAttempts.clear();
}

function consumeJoinBudget(principalId: string, now: number): boolean {
  for (const [key, times] of joinAttempts) {
    const live = times.filter((at) => now - at < JOIN_WINDOW_MS);
    if (live.length === 0) joinAttempts.delete(key);
    else if (live.length !== times.length) joinAttempts.set(key, live);
  }
  const global = joinAttempts.get("__global__") ?? [];
  const key = `principal:${principalId}`;
  const mine = joinAttempts.get(key) ?? [];
  if (global.length >= JOIN_GLOBAL || mine.length >= JOIN_PER_PRINCIPAL) {
    return false;
  }
  global.push(now);
  mine.push(now);
  joinAttempts.set("__global__", global);
  joinAttempts.set(key, mine);
  while (joinAttempts.size > JOIN_MAX_KEYS) {
    const victim = [...joinAttempts.keys()].find(
      (candidate) => candidate !== "__global__",
    );
    if (victim === undefined) break;
    joinAttempts.delete(victim);
  }
  return true;
}

/** Test hook: the budget is process-global. */
export function resetTenantLookupBudget(): void {
  tenantLookupAttempts.clear();
}

function consumeTenantLookupBudget(fingerprint: string, now: number): boolean {
  for (const [key, times] of tenantLookupAttempts) {
    const live = times.filter((at) => now - at < TENANT_LOOKUP_WINDOW_MS);
    if (live.length === 0) tenantLookupAttempts.delete(key);
    else if (live.length !== times.length) {
      tenantLookupAttempts.set(key, live);
    }
  }
  const clientKey = `client:${fingerprint}`;
  const global = tenantLookupAttempts.get(TENANT_LOOKUP_GLOBAL_KEY) ?? [];
  const client = tenantLookupAttempts.get(clientKey) ?? [];
  if (
    global.length >= TENANT_LOOKUP_GLOBAL ||
    client.length >= TENANT_LOOKUP_PER_CLIENT
  ) {
    return false;
  }
  global.push(now);
  client.push(now);
  tenantLookupAttempts.set(TENANT_LOOKUP_GLOBAL_KEY, global);
  tenantLookupAttempts.set(clientKey, client);
  while (tenantLookupAttempts.size > TENANT_LOOKUP_MAX_KEYS) {
    const victim = [...tenantLookupAttempts.keys()].find(
      (key) => key !== TENANT_LOOKUP_GLOBAL_KEY,
    );
    if (victim === undefined) break;
    tenantLookupAttempts.delete(victim);
  }
  return true;
}

function tenantLookupFingerprint(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  return createHash("sha256")
    .update(c.req.header("user-agent") ?? "")
    .update("|")
    .update(c.req.header("origin") ?? "")
    .digest("hex")
    .slice(0, 16);
}

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
    const base = secureServiceEndpoint(configuredUrl);
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

function membershipResponse(membership: OrganizationMembership) {
  return OrganizationMembershipResponseSchema.parse({
    ...membership,
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
  });
}

export type OrganizationRevocationInput = {
  organizationId: string;
  principalId: string;
  correlationId: string;
  /** Why authority was withdrawn — recorded on the audit row. */
  reason: string;
  /**
   * Finish session revocation even when the membership row was already gone.
   * A deprovisioning retry after a partial failure needs this: the first
   * attempt removed the row and then failed before ending sessions.
   */
  revokeSessionsWithoutMembership?: boolean;
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

  // A membership that was already gone normally authorized nothing here, and
  // the holder's sessions are not this tenant's to end (a repeated sync pass,
  // or a subject some other tenant's directory happens to name). A SCIM retry
  // is the exception: it named the principal through this tenant's own
  // identity tuple, so finishing an interrupted revocation is still in scope.
  let sessionsRevoked = 0;
  const sessions =
    membershipRemoved || input.revokeSessionsWithoutMembership
      ? await ctx.stores.provisionalSessions.entries()
      : [];
  for (const [, session] of sessions) {
    if (session.principalId !== input.principalId) continue;
    await ctx.stores.provisionalSessions.delete(session.id);
    sessionsRevoked += 1;
  }
  await removeOrphanTokens(ctx.stores);

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
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    ctx.log.warn("Host session revocation failed");
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
    return asVerifiedPrincipal(
      c,
      "Verified identity required to create an organization",
      async ({ actor, proof, principal }) => {
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
          issuerConfigurationError(ctx.config, parsed.data.ssoIssuer) ??
          issuerConfigurationError(ctx.config, parsed.data.samlIssuer);
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
              return c.json(
                { error: "forbidden", reasons: decision.reasons },
                403,
              );
            }

            if (await ctx.stores.organizations.getBySlug(parsed.data.slug)) {
              return c.json({ error: "slug_taken" }, 409);
            }
            if (
              (await issuerClaimed(ctx, parsed.data.samlIssuer)) ||
              (await issuerClaimed(ctx, parsed.data.ssoIssuer))
            ) {
              return c.json(
                {
                  error: "issuer_taken",
                  message:
                    "That identity provider already belongs to another tenant.",
                },
                409,
              );
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
            await createOrganization(ctx, actor, proof, org);
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
  },
);

organizationRoutes.get("/tenants/:slug", async (c) => {
  const ctx = c.get("ctx");
  if (
    !consumeTenantLookupBudget(
      tenantLookupFingerprint(c),
      ctx.clock().getTime(),
    )
  ) {
    c.header("retry-after", "60");
    return c.json({ error: "rate_limited" }, 429);
  }
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
 * Public home-realm discovery by email DOMAIN — the JSON twin of the login
 * page's `POST /interaction/:uid/federated/realm`, so a client app can offer
 * ONE identifier field instead of a slug field beside a work-email field.
 *
 * Anti-enumeration contract (same as the realm route's NO_REALM_MESSAGE, see
 * routes/interactions-realm.ts): malformed input, an unknown domain, a
 * claimed-but-unverified domain, and a suspended or deleted organization all
 * return this exact 404 body. Only VERIFIED domains route — an unverified
 * claim is an assertion by whoever typed it, and honouring it would let
 * anyone redirect a competitor's employees to their own IdP. The response is
 * exactly what the slug lookup above already publishes for the same tenant —
 * this endpoint reveals the domain→org edge, which the interaction realm POST
 * already served unauthenticated, and nothing more.
 */
organizationRoutes.get("/by-domain/:domain", async (c) => {
  const ctx = c.get("ctx");
  if (
    !consumeTenantLookupBudget(
      tenantLookupFingerprint(c),
      ctx.clock().getTime(),
    )
  ) {
    c.header("retry-after", "60");
    return c.json({ error: "rate_limited" }, 429);
  }
  const domain = normalizeEmailDomain(c.req.param("domain"));
  const claim = domain
    ? await ctx.stores.orgFederation.emailDomains.findVerified(domain)
    : null;
  const org = claim
    ? await ctx.stores.organizations.get(claim.organizationId)
    : undefined;
  if (!org || org.state === "deleted" || org.state === "suspended") {
    return c.json({ error: "not_found" }, 404);
  }
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
    if (!consumeJoinBudget(principalId, ctx.clock().getTime())) {
      c.header("retry-after", "60");
      return c.json({ error: "rate_limited" }, 429);
    }
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
      assertion = await name(
        organizationId(org.id),
        { ssoIssuer: issuer },
        (tenant, configuration) => {
          const verdict = organizationIssuerAdmission(
            ctx.config,
            tenant,
            configuration,
          );
          if (!verdict.ok)
            throw new OrganizationIssuerApprovalError(verdict.message);
          return verifyAdmittedOrganizationAssertion(
            ctx,
            tenant,
            configuration,
            verdict.proof,
            parsed.data.idToken,
          );
        },
      );
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
      // The tenant's own IdP asserted this address. It joins accounts only
      // for a domain the organization proved it controls, the same rule the
      // SAML and directory legs use — an owner may speak for their own
      // namespace, not for `@gmail.com` (ADR 0057 §6).
      ...(await emailLinkFields(
        ctx,
        {
          source: "org",
          organizationId: org.id,
          issuer,
          method: parsed.data.method === "saml" ? "saml" : "sso",
        },
        assertion.email,
        assertion.emailVerified,
      )),
    });
    if (!attached.ok) {
      return c.json({ error: attached.error, message: attached.message }, 409);
    }

    // Verified-email auto-link (ADR 0057 D15) can store the new identity on a
    // different principal than the caller. Membership follows that owner, the
    // same way hosted SSO, LDAP, and SAML do. The caller is not made a member
    // and their session stays the provisional principal they presented.
    const memberPrincipalId = attached.identity.principalId;
    // A subject the directory provisioned into a role joins at that role, not
    // at `member` (C15) — the same answer this tenant's hosted sign-in gives.
    const role = await provisionedRoleForSubject(ctx, org.id, assertion.sub);
    const joined = await jitJoinOrganization(ctx, {
      organization: org,
      principalId: memberPrincipalId,
      subject: assertion.sub,
      method: parsed.data.method,
      correlationId: c.get("correlationId"),
      ...(role !== undefined ? { role } : undefined),
    });
    if (!joined.ok) {
      return c.json({ error: joined.error, message: joined.message }, 403);
    }
    if (memberPrincipalId !== principalId) {
      return c.json(
        {
          error: "identity_collision",
          message:
            "External identity already bound to another principal; merge requires dual authentication",
        },
        409,
      );
    }
    return joined.created
      ? c.json(toResponse(org, joined.membership.role), 201)
      : c.json(toResponse(org, joined.membership.role));
  },
);

organizationRoutes.patch("/:id", requirePrincipal(), async (c) =>
  asOrgOwner(
    c,
    { param: "id", liveness: "not_deleted" },
    async ({ ctx, org: orgName, proof, actor, organization: org }) => {
      const principalId = actor.value;
      const parsed = UpdateOrganizationRequestSchema.safeParse(
        await c.req.json(),
      );
      if (!parsed.success) {
        return c.json(
          { error: "validation_error", details: parsed.error.flatten() },
          400,
        );
      }
      const patch = <T>(
        submitted: T | null | undefined,
        current: T | undefined,
      ) => (submitted === undefined ? current : (submitted ?? undefined));
      const ssoIssuer = patch(parsed.data.ssoIssuer, org.ssoIssuer);
      const ssoClientId = patch(parsed.data.ssoClientId, org.ssoClientId);
      const ssoClientSecret = patch(
        parsed.data.ssoClientSecret,
        ssoIssuer === org.ssoIssuer && ssoClientId === org.ssoClientId
          ? org.ssoClientSecret
          : undefined,
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
      const samlError = samlConfigurationError(ctx.config, {
        issuer: samlIssuer,
        metadataUrl: samlMetadataUrl,
        metadataXml: samlMetadataXml,
      });
      if (samlError) return c.json(samlError, 400);
      if (
        (parsed.data.samlIssuer !== undefined &&
          (await issuerClaimed(ctx, samlIssuer, org.id))) ||
        (parsed.data.ssoIssuer !== undefined &&
          (await issuerClaimed(ctx, ssoIssuer, org.id)))
      ) {
        return c.json(
          {
            error: "issuer_taken",
            message:
              "That identity provider already belongs to another tenant.",
          },
          409,
        );
      }
      const unsafeIssuer = issuerConfigurationError(
        ctx.config,
        parsed.data.ssoIssuer,
      );
      if (unsafeIssuer) {
        return c.json({ error: "unsafe_issuer", message: unsafeIssuer }, 400);
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
      await writeOrganization(ctx, orgName, proof, updated);
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.updated",
        outcome: "succeeded",
        principalId,
        organizationId: org.id,
        correlationId: c.get("correlationId"),
        metadata: { action: "organization.update" },
      });
      return c.json(toResponse(updated, "owner"));
    },
  ),
);

organizationRoutes.get("/:id/members", requirePrincipal(), async (c) =>
  asOrgOwner(c, MEMBER_ADMIN, async ({ ctx, org }) => {
    const members = (
      await ctx.stores.organizationMemberships.listByOrganization(org.value)
    ).map(membershipResponse);
    return c.json({ members });
  }),
);

organizationRoutes.post("/:id/members", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const organizationId = c.req.param("id");
  return serializeMembershipMutation(ctx, organizationId, () =>
    asOrgOwner(c, MEMBER_ADMIN, async ({ org, proof, actor }) => {
      const principalId = actor.value;
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
      const membership = await writeOrganizationMembership(ctx, org, proof, {
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
    }),
  );
});

organizationRoutes.patch(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const organizationId = c.req.param("id");
    return serializeMembershipMutation(ctx, organizationId, () =>
      asOrgOwner(c, MEMBER_ADMIN, async ({ org, proof, actor }) => {
        const actorPrincipalId = actor.value;
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
        await writeOrganizationMembership(ctx, org, proof, updated);
        if (
          !(await revokeHostSessions(ctx, organizationId, targetPrincipalId))
        ) {
          await writeOrganizationMembership(ctx, org, proof, target);
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
      }),
    );
  },
);

organizationRoutes.delete(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const organizationId = c.req.param("id");
    return serializeMembershipMutation(ctx, organizationId, () =>
      asOrgOwner(c, MEMBER_ADMIN, async ({ org, proof, actor }) => {
        const actorPrincipalId = actor.value;
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
        await removeOrganizationMembership(ctx, org, proof, targetPrincipalId);
        if (
          !(await revokeHostSessions(ctx, organizationId, targetPrincipalId))
        ) {
          await writeOrganizationMembership(ctx, org, proof, target);
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
      }),
    );
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
import { removeOrphanTokens } from "../repos/session-storage.js";
