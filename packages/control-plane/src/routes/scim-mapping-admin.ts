import type { OrganizationRole } from "@opensesame/os-domain";
import { isString, overlapCast } from "@opensesame/os-domain";
import { type Context, Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { authenticatedPrincipalId } from "./organizations.js";
import { putGroupRoleMapping } from "./scim-groups.js";

const ROLES = new Set<OrganizationRole>(["owner", "admin", "member"]);

export const scimMappingAdminRoutes = new Hono<{ Variables: Variables }>();

async function requireOrgOwner(
  c: Context<{ Variables: Variables }>,
): Promise<Response | { organizationId: string }> {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const organizationId = c.req.param("organizationId");
  if (!organizationId) {
    return c.json({ error: "not_found" }, 404);
  }
  const membership = await ctx.stores.organizationMemberships.find(
    organizationId,
    principalId,
  );
  if (!membership) return c.json({ error: "not_found" }, 404);
  if (membership.role !== "owner") {
    return c.json({ error: "owner_required" }, 403);
  }
  return { organizationId };
}

scimMappingAdminRoutes.get(
  "/:organizationId/scim/mappings",
  requirePrincipal(),
  async (c) => {
    const gate = await requireOrgOwner(c);
    if (gate instanceof Response) return gate;
    const mappings = await c
      .get("ctx")
      .stores.scim.mappings.listByOrganization(gate.organizationId);
    return c.json({ mappings });
  },
);

scimMappingAdminRoutes.put(
  "/:organizationId/scim/mappings/:groupId",
  requirePrincipal(),
  async (c) => {
    const gate = await requireOrgOwner(c);
    if (gate instanceof Response) return gate;
    const groupId = decodeURIComponent(c.req.param("groupId") ?? "");
    const body = overlapCast(await c.req.json().catch(() => ({})));
    const role = isString(body.role) ? body.role : "";
    if (
      !groupId ||
      (role !== "owner" && role !== "admin" && role !== "member")
    ) {
      return c.json({ error: "validation_error" }, 400);
    }
    await putGroupRoleMapping(c.get("ctx"), gate.organizationId, groupId, role);
    return c.json({
      organizationId: gate.organizationId,
      groupId,
      role,
    });
  },
);
