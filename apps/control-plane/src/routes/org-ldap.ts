import { appendAuditEvent } from "@opensesame/audit";
import type { OrgLdapConfig } from "@opensesame/os-domain";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  LdapConfigurationError,
  assertUsableLdapConfig,
  ldapIssuer,
  syncLdapDirectory,
} from "../interactions/ldap.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * Owner-facing LDAP configuration and the manual sync trigger (C21 / D17).
 *
 * INTEGRATOR: mount alongside the organization routes in `src/app.ts` (S1's
 * file), on the same prefix — the same shape `createFederatedSessionRoutes`
 * uses to add routes to `/v1/principals` from its own module:
 *
 *   app.route("/v1/organizations", createOrgLdapRoutes());
 *
 * Owner-gated throughout. The secret half of the configuration (the service
 * bind password) is write-only: it goes in, it is used for search binds, and
 * no read path ever returns it.
 */

/**
 * The strings a directory configuration is made of. Bounded deliberately: a DN
 * or a filter is a line of text, and an unbounded one is a payload.
 */
const LdapDn = z.string().trim().min(1).max(512);
const LdapRole = z.enum(["owner", "admin", "member"]);

const OrgLdapConfigRequestSchema = z
  .object({
    url: z.string().trim().min(1).max(512),
    bindMode: z.enum(["bind_template", "search_bind"]),
    bindTemplate: LdapDn.optional(),
    searchBaseDn: LdapDn.optional(),
    searchFilter: z.string().trim().min(1).max(512).optional(),
    serviceBindDn: LdapDn.optional(),
    serviceBindSecret: z.string().min(1).max(512).optional(),
    subjectAttribute: z
      .string()
      .trim()
      .min(1)
      .max(64)
      // An attribute name, not an expression: the value is interpolated into
      // the requested-attribute list on every search.
      .regex(/^[A-Za-z][A-Za-z0-9;-]*$/),
    attributeMap: z
      .object({
        email: z.string().trim().min(1).max(64).optional(),
        name: z.string().trim().min(1).max(64).optional(),
      })
      .default({}),
    groupRoleMap: z
      .record(z.string().trim().min(1).max(512), LdapRole)
      .default({}),
  })
  .strict();

function configFromRequest(
  organizationId: string,
  input: z.infer<typeof OrgLdapConfigRequestSchema>,
): OrgLdapConfig {
  const config: OrgLdapConfig = {
    organizationId,
    url: input.url,
    bindMode: input.bindMode,
    subjectAttribute: input.subjectAttribute,
    attributeMap: {
      ...(input.attributeMap.email !== undefined
        ? { email: input.attributeMap.email }
        : undefined),
      ...(input.attributeMap.name !== undefined
        ? { name: input.attributeMap.name }
        : undefined),
    },
    groupRoleMap: { ...input.groupRoleMap },
  };
  if (input.bindTemplate) config.bindTemplate = input.bindTemplate;
  if (input.searchBaseDn) config.searchBaseDn = input.searchBaseDn;
  if (input.searchFilter) config.searchFilter = input.searchFilter;
  if (input.serviceBindDn) config.serviceBindDn = input.serviceBindDn;
  if (input.serviceBindSecret) {
    config.serviceBindSecret = input.serviceBindSecret;
  }
  return config;
}

/**
 * What an owner may read back.
 *
 * `serviceBindSecret` is deliberately absent — it is presented to the
 * directory verbatim and therefore cannot be hashed, which makes "never read
 * it back out" the only fence left. `serviceBindConfigured` says whether one
 * is set, which is the only thing a settings screen actually needs.
 */
function configResponse(config: OrgLdapConfig) {
  return {
    organizationId: config.organizationId,
    url: config.url,
    issuer: ldapIssuer(config),
    bindMode: config.bindMode,
    subjectAttribute: config.subjectAttribute,
    attributeMap: config.attributeMap,
    groupRoleMap: config.groupRoleMap,
    serviceBindConfigured: Boolean(config.serviceBindSecret),
    ...(config.bindTemplate
      ? { bindTemplate: config.bindTemplate }
      : undefined),
    ...(config.searchBaseDn
      ? { searchBaseDn: config.searchBaseDn }
      : undefined),
    ...(config.searchFilter
      ? { searchFilter: config.searchFilter }
      : undefined),
    ...(config.serviceBindDn
      ? { serviceBindDn: config.serviceBindDn }
      : undefined),
  };
}

async function requireOwner(
  ctx: AppContext,
  organizationId: string,
  principalId: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404; error: string }> {
  const org = await ctx.stores.organizations.get(organizationId);
  const membership = org
    ? await ctx.stores.organizationMemberships.find(org.id, principalId)
    : undefined;
  if (!org || org.state === "deleted" || !membership) {
    return { ok: false, status: 404, error: "not_found" };
  }
  if (membership.role !== "owner") {
    return { ok: false, status: 403, error: "owner_required" };
  }
  return { ok: true };
}

export function createOrgLdapRoutes(): Hono<{ Variables: Variables }> {
  const routes = new Hono<{ Variables: Variables }>();

  routes.get("/:id/ldap", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const organizationId = c.req.param("id");
    const owner = await requireOwner(ctx, organizationId, principalId);
    if (!owner.ok) return c.json({ error: owner.error }, owner.status);

    const config =
      await ctx.stores.orgFederation.ldapConfigs.get(organizationId);
    if (!config) return c.json({ error: "not_found" }, 404);
    return c.json(configResponse(config));
  });

  routes.put("/:id/ldap", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const organizationId = c.req.param("id");
    const owner = await requireOwner(ctx, organizationId, principalId);
    if (!owner.ok) return c.json({ error: owner.error }, owner.status);

    const parsed = OrgLdapConfigRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const config = configFromRequest(organizationId, parsed.data);
    try {
      // Validated at configuration time, not only at sign-in time: an owner
      // must learn here that ldap:// is refused in production and that the
      // server will not bind to a private or metadata address (T21), rather
      // than discovering it from a failed login weeks later.
      assertUsableLdapConfig(ctx, config);
    } catch (error) {
      if (error instanceof LdapConfigurationError) {
        return c.json({ error: error.code, message: error.message }, 400);
      }
      throw error;
    }

    const stored = await ctx.stores.orgFederation.ldapConfigs.put(config);
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.ldap_configured",
      outcome: "succeeded",
      principalId,
      organizationId,
      correlationId: c.get("correlationId"),
      metadata: {
        action: "organization.ldap.configure",
        issuer: ldapIssuer(stored),
        method: stored.bindMode,
      },
    });
    return c.json(configResponse(stored));
  });

  routes.delete("/:id/ldap", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const organizationId = c.req.param("id");
    const owner = await requireOwner(ctx, organizationId, principalId);
    if (!owner.ok) return c.json({ error: owner.error }, owner.status);

    const removed =
      await ctx.stores.orgFederation.ldapConfigs.remove(organizationId);
    if (!removed) return c.json({ error: "not_found" }, 404);
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.ldap_removed",
      outcome: "succeeded",
      principalId,
      organizationId,
      correlationId: c.get("correlationId"),
      metadata: { action: "organization.ldap.remove" },
    });
    return c.body(null, 204);
  });

  /**
   * Run a directory sync now.
   *
   * The manual half of D17's "scheduled + manually-triggerable" pull: an owner
   * who has just deprovisioned somebody should not have to wait for the next
   * scheduled pass for that person's sessions to end.
   */
  routes.post("/:id/ldap/sync", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const organizationId = c.req.param("id");
    const owner = await requireOwner(ctx, organizationId, principalId);
    if (!owner.ok) return c.json({ error: owner.error }, owner.status);

    const config =
      await ctx.stores.orgFederation.ldapConfigs.get(organizationId);
    if (!config) return c.json({ error: "not_found" }, 404);

    try {
      const summary = await syncLdapDirectory(ctx, config);
      return c.json(summary);
    } catch (error) {
      if (error instanceof LdapConfigurationError) {
        return c.json({ error: error.code, message: error.message }, 400);
      }
      // A directory that is down, refusing the service bind, or dropping the
      // connection is an upstream failure, not a client error — and its
      // message stays in the log rather than in the response.
      ctx.log.warn(
        {
          organizationId,
          error: error instanceof Error ? error.name : "unknown",
        },
        "LDAP directory sync failed",
      );
      return c.json({ error: "directory_unavailable" }, 502);
    }
  });

  return routes;
}
