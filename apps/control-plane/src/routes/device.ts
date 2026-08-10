import { Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";

/**
 * Device authorization approval — Identity plane proxy to Host API.
 * Browsers must never hold OPENSESAME_OPERATOR_TOKEN; the control-plane injects it server-side.
 */
export const deviceRoutes = new Hono<{ Variables: Variables }>();

function authenticatedPrincipalId(value: string | undefined): string {
  if (!value) throw new Error("requirePrincipal middleware invariant violated");
  return value;
}

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
  const body = await c.req.json<{
    user_code?: string;
    organization_id?: string;
    organization_role?: string;
    principal?: string;
  }>();
  const userCode = body.user_code?.trim();
  if (!userCode) {
    return c.json(
      { error: "invalid_request", hint: "user_code required" },
      400,
    );
  }
  const memberships = [...ctx.stores.organizationMemberships.values()].filter(
    (membership) => membership.principalId === principalId,
  );
  const organizationId =
    body.organization_id?.trim() ||
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
  const membership = memberships.find(
    (candidate) => candidate.organizationId === organizationId,
  );
  const organization = ctx.stores.organizations.get(organizationId);
  if (!membership || !organization || organization.state !== "active") {
    return c.json({ error: "organization_access_denied" }, 403);
  }
  const url = `${ctx.config.hostApiUrl}/api/v1/device/approve`;
  try {
    const parsed = new URL(ctx.config.hostApiUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return c.json({ error: "invalid_host_api_url" }, 500);
    }
    if (parsed.username || parsed.password) {
      return c.json(
        { error: "invalid_host_api_url", hint: "credentials in URL denied" },
        500,
      );
    }
  } catch {
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
