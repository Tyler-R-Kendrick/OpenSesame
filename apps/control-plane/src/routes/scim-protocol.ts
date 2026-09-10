import type { JsonObject } from "@opensesame/os-domain";
import type { Context } from "hono";
import type { Variables } from "../middleware/context.js";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_CONTENT_TYPE = "application/scim+json";
type ScimStatus = 400 | 401 | 403 | 404 | 409;

export function scimBody(
  c: Context<{ Variables: Variables }>,
  status: ScimStatus | 200 | 201,
  payload: JsonObject,
): Response {
  return c.body(JSON.stringify(payload), status, {
    "content-type": SCIM_CONTENT_TYPE,
  });
}

/**
 * A SCIM-shaped error. Directory clients parse this envelope; a bare
 * `{ error: ... }` is reported by Okta as an unknown failure with no detail.
 */
export function scimError(
  c: Context<{ Variables: Variables }>,
  status: ScimStatus,
  detail: string,
  scimType?: string,
): Response {
  return scimBody(c, status, {
    schemas: [ERROR_SCHEMA],
    ...(scimType !== undefined ? { scimType } : undefined),
    detail,
    status: String(status),
  });
}

export function scimAuditActor(c: Context<{ Variables: Variables }>): {
  actorType: "human" | "system";
  actorId: string;
  principalId?: string;
} {
  const principalId = c.get("principalId");
  const provisioningToken = (c.req.header("authorization") ?? "")
    .toLowerCase()
    .startsWith("bearer sct_");
  return principalId && !provisioningToken
    ? { actorType: "human", actorId: principalId, principalId }
    : { actorType: "system", actorId: "scim" };
}

export function scimUserUpdateAudit(wasActive: boolean, active: boolean) {
  const deactivated = wasActive && !active;
  return {
    eventType: deactivated
      ? "organization.scim_user_deactivated"
      : "organization.scim_user_updated",
    metadata: {
      action: deactivated
        ? "organization.scim_user.deactivate"
        : "organization.scim_user.update",
      state: active ? "active" : "inactive",
    },
  };
}
