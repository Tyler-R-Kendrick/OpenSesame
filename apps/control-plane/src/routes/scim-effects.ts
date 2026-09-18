import type { ScimUserRecord } from "@opensesame/database";
import type { Organization, OrganizationRole } from "@opensesame/os-domain";
import { isString } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import {
  revokeOrganizationMembership,
  serializeMembershipMutation,
} from "./organizations.js";

/**
 * Where a Groups PATCH records the derived role, on the SCIM row itself.
 * Stripped from every representation this route renders.
 */
export const SCIM_ROLE_ATTRIBUTE = "urn:opensesame:params:scim:2.0:role";

/** Prior userName/externalId values, so a rename still deprovisions. */
export const SCIM_SUBJECTS_ATTRIBUTE =
  "urn:opensesame:params:scim:2.0:subjects";

const ORG_IDENTITY_KINDS = ["oidc", "oauth2", "saml", "ldap", "email"] as const;

export function roleOf(user: ScimUserRecord): OrganizationRole | undefined {
  const stored = user.raw[SCIM_ROLE_ATTRIBUTE];
  return stored === "owner" || stored === "admin" || stored === "member"
    ? stored
    : undefined;
}

export function rememberedSubjects(...users: ScimUserRecord[]): string[] {
  const subjects = new Set<string>();
  for (const user of users) {
    if (user.externalId) subjects.add(user.externalId);
    if (user.userName) subjects.add(user.userName);
    const extra = user.raw[SCIM_SUBJECTS_ATTRIBUTE];
    if (!Array.isArray(extra)) continue;
    for (const value of extra) {
      if (isString(value) && value) subjects.add(value);
    }
  }
  return [...subjects];
}

export function withRememberedSubjects(
  previous: ScimUserRecord,
  next: ScimUserRecord,
): ScimUserRecord {
  return {
    ...next,
    raw: {
      ...next.raw,
      [SCIM_SUBJECTS_ATTRIBUTE]: rememberedSubjects(previous, next),
    },
  };
}

/**
 * The role a directory-provisioned subject should join at, or `undefined`
 * when no mapped Groups push has said otherwise.
 */
export async function provisionedRoleForSubject(
  ctx: AppContext,
  organizationId: string,
  subject: string,
): Promise<OrganizationRole | undefined> {
  const user = await ctx.stores.scim.users.findBySubject(
    organizationId,
    subject,
  );
  if (!user?.active) return undefined;
  return roleOf(user);
}

async function principalsForSubject(
  ctx: AppContext,
  organization: Organization,
  subject: string,
): Promise<string[]> {
  const issuers = [organization.ssoIssuer, organization.samlIssuer].filter(
    (issuer): issuer is string => isString(issuer) && issuer.length > 0,
  );
  const principalIds = new Set<string>();
  for (const issuer of issuers) {
    for (const kind of ORG_IDENTITY_KINDS) {
      const identity = await ctx.repos.externalIdentities.findByTuple({
        kind,
        issuer,
        subject,
      });
      if (identity) principalIds.add(identity.principalId);
    }
  }
  return [...principalIds];
}

async function principalsForUser(
  ctx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
): Promise<string[]> {
  const principalIds = new Set<string>();
  for (const subject of rememberedSubjects(user)) {
    for (const id of await principalsForSubject(ctx, organization, subject)) {
      principalIds.add(id);
    }
  }
  return [...principalIds];
}

/** Withdraw a deactivated subject's membership and live sessions (D11). */
export async function deprovision(
  ctx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  correlationId: string,
  previous?: ScimUserRecord,
): Promise<void> {
  const record = previous ? withRememberedSubjects(previous, user) : user;
  for (const principalId of await principalsForUser(
    ctx,
    organization,
    record,
  )) {
    await revokeOrganizationMembership(ctx, {
      organizationId: organization.id,
      principalId,
      correlationId,
      reason: "scim_deactivated",
    });
  }
}

/** Apply a Groups mapping to whoever already holds a membership here. */
export async function applyRole(
  ctx: AppContext,
  organization: Organization,
  user: ScimUserRecord,
  role: OrganizationRole,
): Promise<void> {
  for (const principalId of await principalsForUser(ctx, organization, user)) {
    await serializeMembershipMutation(ctx, organization.id, async () => {
      const existing = await ctx.stores.organizationMemberships.find(
        organization.id,
        principalId,
      );
      if (!existing || existing.role === role) return;
      await ctx.stores.organizationMemberships.upsert({
        ...existing,
        role,
        updatedAt: ctx.clock(),
      });
    });
  }
}
