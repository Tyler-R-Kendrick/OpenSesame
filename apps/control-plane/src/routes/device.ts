import { Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import {
  authenticatedPrincipalId,
  ensurePersonalOrganization,
  hostApiEndpoint,
  membershipKey,
  serializeMembershipMutation,
} from "./organizations.js";

/**
 * Device authorization approval — Identity plane proxy to Host API.
 * Browsers must never hold OPENSESAME_OPERATOR_TOKEN; the control-plane injects it server-side.
 */
export const deviceRoutes = new Hono<{ Variables: Variables }>();

deviceRoutes.post("/approve", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  if (!ctx.config.operatorToken) {
    return c.json(
      {
        error: "operator_token_unconfigured",
        hint: "Set OPENSESAME_OPERATOR_TOKEN on the Identity API",
      },
      503,
    );
  }
  const parsedBody: unknown = await c.req.json().catch(() => undefined);
  const body =
    parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
      ? (parsedBody as Record<string, unknown>)
      : {};
  const userCode =
    typeof body.user_code === "string" ? body.user_code.trim() : "";
  if (!userCode) {
    return c.json(
      { error: "invalid_request", hint: "user_code required" },
      400,
    );
  }
  let memberships = [...ctx.stores.organizationMemberships.values()].filter(
    (membership) => membership.principalId === principalId,
  );
  // Local/dev Pages flow: a provisional principal with no workspace yet still
  // needs a Host session. Seed the personal org on approve, not only at mint.
  if (
    memberships.length === 0 &&
    ctx.config.bootstrapPersonalOrganization
  ) {
    ensurePersonalOrganization(ctx, principalId);
    memberships = [...ctx.stores.organizationMemberships.values()].filter(
      (membership) => membership.principalId === principalId,
    );
  }
  const organizationId =
    (typeof body.organization_id === "string"
      ? body.organization_id.trim()
      : "") ||
    (memberships.length === 1 ? memberships[0]?.organizationId : undefined);
  if (!organizationId) {
    return c.json(
      {
        error: "organization_id_required",
        hint: "Select one of your organizations",
      },
      400,
    );
  }
  return serializeMembershipMutation(ctx, organizationId, async () => {
    // Membership changes use the same per-organization fence. Holding it from
    // this authoritative re-read through Host approval gives a strict order:
    // either approval lands first and the following mutation revokes it, or the
    // mutation lands first and this request observes the new authority.
    const membership = ctx.stores.organizationMemberships.get(
      membershipKey(organizationId, principalId),
    );
    const organization = ctx.stores.organizations.get(organizationId);
    if (!membership || !organization || organization.state !== "active") {
      return c.json({ error: "organization_access_denied" }, 403);
    }
    const url = hostApiEndpoint(ctx.config.hostApiUrl, "api/v1/device/approve");
    if (!url) {
      return c.json({ error: "invalid_host_api_url" }, 500);
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opensesame-operator": ctx.config.operatorToken,
        },
        body: JSON.stringify({
          user_code: userCode,
          // Always bind to the authenticated Identity principal — never trust client-supplied principal.
          principal: principalId,
          // Organization and role come from Identity state. Browser-supplied role is ignored.
          organization_id: organizationId,
          organization_role: membership.role,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      const text = await res.text();
      let payload: unknown = text;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        /* keep text */
      }
      // `url` is deliberately not echoed: the Host API address is internal
      // topology, and callers only need the approval outcome.
      return c.json(
        {
          ok: res.ok,
          status: res.status,
          body: payload,
        },
        res.ok ? 200 : res.status === 404 ? 404 : 502,
      );
    } catch (err) {
      ctx.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "device approve proxy failed",
      );
      return c.json(
        {
          error: "host_api_unreachable",
          hint: "Is Host API up on OPENSESAME_HOST_API / OPENSESAME_SERVER?",
        },
        502,
      );
    }
  });
});
