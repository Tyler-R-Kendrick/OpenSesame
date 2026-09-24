import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import type { ScimUserRecord } from "@opensesame/database";
import {
  type BoundaryValue,
  type JsonObject,
  type Organization,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import {
  SCIM_ROLE_ATTRIBUTE,
  SCIM_SUBJECTS_ATTRIBUTE,
  deprovision,
  provisionedRoleForSubject,
  withRememberedSubjects,
} from "./scim-effects.js";
import {
  patchScimGroup,
  putGroupRoleMapping,
  roleForGroupName,
} from "./scim-groups.js";
import {
  type ScimPatchOperation,
  boundedScimString,
  readScimJsonBody,
  scimAuditActor,
  scimBody,
  scimError,
  scimPatchOperations,
  scimUserUpdateAudit,
} from "./scim-protocol.js";

export { provisionedRoleForSubject, putGroupRoleMapping, roleForGroupName };

/**
 * SCIM 2.0 directory provisioning, per organization (C15, D11, ADR 0056).
 *
 * Okta, Entra and friends push joiners, movers and leavers here so membership
 * follows the customer's directory instead of whoever happened to sign in. The
 * base URL an administrator configures is
 * `<publicUrl>/v1/organizations/<organizationId>/scim/v2` — the tenant is in
 * the path because a provisioning token is org-scoped, and the store answers
 * "is this hash live for THIS org", never "whose token is this".
 *
 * Two rules shape everything below.
 *
 * **No principal is minted at provision time.** A provisioned row is the
 * organization's standing answer to "may this subject join when it eventually
 * signs in?" — nothing more. The identity is created by the sign-in leg that
 * actually verified an assertion (`jitJoinOrganization` consults these rows
 * when the tenant marks provisioning authoritative), so a directory push can
 * never manufacture an account nobody authenticated as.
 *
 * **Deprovisioning has to bite immediately.** Flipping `active` to false — by
 * PATCH or by DELETE, which SCIM treats as the same intent — drops the
 * membership and every session it authorised. A deactivation that left live
 * bearers behind would leave a departed employee signed in for the rest of the
 * session TTL, which is the one failure mode directory sync exists to prevent.
 */

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

/** Provisioning-token prefix. Shown once, at mint; only the hash is stored. */
export const SCIM_TOKEN_PREFIX = "sct_";

/** Attributes never kept, whatever the directory sends. */
const NEVER_STORED = new Set(["password", "schemas", "meta", "id"]);
const BOOKKEEPING = new Set([SCIM_ROLE_ATTRIBUTE, SCIM_SUBJECTS_ATTRIBUTE]);

const MAX_USER_NAME_LENGTH = 320;
const MAX_DISPLAY_LENGTH = 512;

function scimTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Attributes as the directory sent them, minus what we must never keep. */
function sanitizeRaw(body: JsonObject): JsonObject {
  const raw: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    // `password` is a real SCIM attribute and a real credential. It is dropped
    // before anything durable sees it: this service authenticates nobody by a
    // directory-supplied password, so keeping one would be pure liability.
    if (NEVER_STORED.has(key) || BOOKKEEPING.has(key)) continue;
    raw[key] = value;
  }
  return raw;
}

function userLocation(base: string, id: string): string {
  return `${base}/Users/${encodeURIComponent(id)}`;
}

function scimBase(ctx: AppContext, organizationId: string): string {
  return `${ctx.config.publicUrl}/v1/organizations/${encodeURIComponent(
    organizationId,
  )}/scim/v2`;
}

/** The SCIM representation of a stored row — never the bookkeeping key. */
function userResource(ctx: AppContext, user: ScimUserRecord): JsonObject {
  const attributes: JsonObject = {};
  for (const [key, value] of Object.entries(user.raw)) {
    if (BOOKKEEPING.has(key)) continue;
    attributes[key] = value;
  }
  return {
    ...attributes,
    schemas: [USER_SCHEMA],
    id: user.id,
    userName: user.userName,
    active: user.active,
    ...(user.externalId !== undefined
      ? { externalId: user.externalId }
      : undefined),
    ...(user.displayName !== undefined
      ? { displayName: user.displayName }
      : undefined),
    meta: {
      resourceType: "User",
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      location: userLocation(scimBase(ctx, user.organizationId), user.id),
    },
  };
}

/**
 * Authenticate a provisioning request.
 *
 * The presented bearer is hashed before it is compared with anything: the
 * store holds digests and nothing else, so a database read can never hand back
 * a usable credential (T27). An unknown organization, a suspended one, a
 * missing bearer and a wrong bearer all answer the same 401 — telling a
 * stranger which of those it was would make this an org-existence oracle.
 */
async function authenticate(
  c: Context<{ Variables: Variables }>,
): Promise<{ ctx: AppContext; organization: Organization } | Response> {
  const ctx = c.get("ctx");
  const unauthorized = () => {
    c.header("WWW-Authenticate", "Bearer");
    return scimError(c, 401, "Provisioning token required.");
  };

  const header = c.req.header("authorization") ?? "";
  // The first-party directory uses the authenticated owner session, never a
  // provisioning secret copied into a browser. SCIM tokens keep their own path.
  if (c.get("principalId") && !header.slice(7).startsWith(SCIM_TOKEN_PREFIX)) {
    return requireOwner(c);
  }
  if (!header.toLowerCase().startsWith("bearer ")) return unauthorized();
  const presented = header.slice(7).trim();
  if (!presented.startsWith(SCIM_TOKEN_PREFIX)) return unauthorized();

  const organizationId = c.req.param("organizationId") ?? "";
  const organization = await ctx.stores.organizations.get(organizationId);
  if (
    !organization ||
    organization.state === "deleted" ||
    organization.state === "suspended"
  ) {
    return unauthorized();
  }
  const live = await ctx.stores.scim.tokens.verify(
    organization.id,
    scimTokenHash(presented),
  );
  if (!live) return unauthorized();
  return { ctx, organization };
}

/** Owner-fenced management of the tenant's provisioning tokens (D11). */
async function requireOwner(
  c: Context<{ Variables: Variables }>,
): Promise<
  | { ctx: AppContext; organization: Organization; principalId: string }
  | Response
> {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId") ?? "";
  const organization = await ctx.stores.organizations.get(
    c.req.param("organizationId") ?? "",
  );
  const membership =
    organization &&
    (await ctx.stores.organizationMemberships.find(
      organization.id,
      principalId,
    ));
  if (!organization || organization.state !== "active" || !membership) {
    return c.json({ error: "not_found" }, 404);
  }
  if (membership.role !== "owner") {
    return c.json({ error: "owner_required" }, 403);
  }
  return { ctx, organization, principalId };
}

/**
 * SCIM `active` arrives as a boolean from Okta and as the string `"False"`
 * from Entra. Both mean the same thing, and reading only one of them is the
 * classic way a deprovisioning push silently does nothing.
 */
function asActive(value: BoundaryValue): boolean | undefined {
  if (isBoolean(value)) return value;
  if (!isString(value)) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

type UserPatch = {
  active?: boolean;
  userName?: string;
  displayName?: string;
  externalId?: string;
};

/** Fold one PATCH body into the fields this service models. */
function foldUserPatch(operations: ScimPatchOperation[]): UserPatch {
  const patch: UserPatch = {};
  const assign = (path: string, value: BoundaryValue) => {
    const attribute = path.split(".").pop()?.toLowerCase() ?? "";
    if (attribute === "active") {
      const active = asActive(value);
      if (active !== undefined) patch.active = active;
      return;
    }
    if (attribute === "username") {
      const userName = boundedScimString(value, MAX_USER_NAME_LENGTH);
      if (userName) patch.userName = userName;
      return;
    }
    if (attribute === "displayname") {
      const displayName = boundedScimString(value, MAX_DISPLAY_LENGTH);
      if (displayName) patch.displayName = displayName;
      return;
    }
    if (attribute === "externalid") {
      const externalId = boundedScimString(value, MAX_USER_NAME_LENGTH);
      if (externalId) patch.externalId = externalId;
    }
    // Anything else is accepted and ignored: SCIM clients push whole profiles
    // and a 400 on an attribute we do not model would stall the whole sync.
  };

  for (const operation of operations) {
    if (operation.op === "remove" && operation.path) {
      // The one removal that means something here: dropping `active` is how
      // some clients express deactivation.
      if (operation.path.toLowerCase() === "active") patch.active = false;
      continue;
    }
    if (operation.path && operation.value !== undefined) {
      assign(operation.path, operation.value);
      continue;
    }
    if (isJsonObject(operation.value)) {
      for (const [key, value] of Object.entries(operation.value)) {
        assign(key, value);
      }
    }
  }
  return patch;
}

/** `filter=userName eq "someone@acme.example"` — the one filter SCIM clients need. */
function userNameFilter(filter: string): string | undefined {
  const match = filter
    .trim()
    .match(/^userName\s+eq\s+(?:"([^"]*)"|'([^']*)')$/i);
  return match?.[1] ?? match?.[2];
}

export function createScimRoutes(): Hono<{ Variables: Variables }> {
  const routes = new Hono<{ Variables: Variables }>();

  routes.post("/:organizationId/scim/tokens", requirePrincipal(), async (c) => {
    const gate = await requireOwner(c);
    if (gate instanceof Response) return gate;
    const { ctx, organization, principalId } = gate;

    // The only moment this value exists in plaintext. It is returned once,
    // stored as a digest, and never written to a log or an audit row (T27).
    const token = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString(
      "base64url",
    )}`;
    const minted = await ctx.stores.scim.tokens.mint(
      organization.id,
      scimTokenHash(token),
    );
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.scim_token_minted",
      outcome: "succeeded",
      principalId,
      organizationId: organization.id,
      correlationId: c.get("correlationId"),
      targetType: "scim_token",
      targetId: minted.id,
      metadata: { action: "organization.scim_token.mint" },
    });
    return c.json(
      {
        id: minted.id,
        token,
        scimBaseUrl: scimBase(ctx, organization.id),
      },
      201,
    );
  });

  routes.get("/:organizationId/scim/tokens", requirePrincipal(), async (c) => {
    const gate = await requireOwner(c);
    if (gate instanceof Response) return gate;
    const { ctx, organization } = gate;
    const tokens = await ctx.stores.scim.tokens.list(organization.id);
    return c.json({
      tokens: tokens.map((record) => ({
        id: record.id,
        createdAt: record.createdAt.toISOString(),
        revokedAt: record.revokedAt?.toISOString() ?? null,
      })),
    });
  });

  routes.delete(
    "/:organizationId/scim/tokens/:tokenId",
    requirePrincipal(),
    async (c) => {
      const gate = await requireOwner(c);
      if (gate instanceof Response) return gate;
      const { ctx, organization, principalId } = gate;
      const tokenId = c.req.param("tokenId") ?? "";
      if (!(await ctx.stores.scim.tokens.revoke(organization.id, tokenId))) {
        return c.json({ error: "not_found" }, 404);
      }
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.scim_token_revoked",
        outcome: "succeeded",
        principalId,
        organizationId: organization.id,
        correlationId: c.get("correlationId"),
        targetType: "scim_token",
        targetId: tokenId,
        metadata: { action: "organization.scim_token.revoke" },
      });
      return c.body(null, 204);
    },
  );

  routes.post("/:organizationId/scim/v2/Users", async (c) => {
    const session = await authenticate(c);
    if (session instanceof Response) return session;
    const { ctx, organization } = session;

    const body = await readScimJsonBody(c);
    if (!body) return scimError(c, 400, "Body is not a SCIM resource.");
    const userName = boundedScimString(body.userName, MAX_USER_NAME_LENGTH);
    if (!userName) {
      return scimError(c, 400, "userName is required.", "invalidValue");
    }
    if (await ctx.stores.scim.users.findByUserName(organization.id, userName)) {
      return scimError(
        c,
        409,
        "A user with that userName already exists.",
        "uniqueness",
      );
    }

    const now = ctx.clock();
    const externalId = boundedScimString(body.externalId, MAX_USER_NAME_LENGTH);
    const displayName = boundedScimString(body.displayName, MAX_DISPLAY_LENGTH);
    const created = await ctx.stores.scim.users.create({
      id: randomUUID(),
      organizationId: organization.id,
      userName,
      active: asActive(body.active) ?? true,
      raw: sanitizeRaw(body),
      createdAt: now,
      updatedAt: now,
      ...(externalId !== undefined ? { externalId } : undefined),
      ...(displayName !== undefined ? { displayName } : undefined),
    });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.scim_user_provisioned",
      outcome: "succeeded",
      organizationId: organization.id,
      correlationId: c.get("correlationId"),
      ...scimAuditActor(c),
      targetType: "scim_user",
      targetId: created.id,
      metadata: { action: "organization.scim_user.create", state: "active" },
    });

    c.header(
      "Location",
      userLocation(scimBase(ctx, organization.id), created.id),
    );
    return scimBody(c, 201, userResource(ctx, created));
  });

  routes.get("/:organizationId/scim/v2/Users", async (c) => {
    const session = await authenticate(c);
    if (session instanceof Response) return session;
    const { ctx, organization } = session;

    const filter = c.req.query("filter");
    let resources: ScimUserRecord[];
    if (filter === undefined || filter.trim() === "") {
      resources = await ctx.stores.scim.users.listByOrganization(
        organization.id,
      );
    } else {
      const userName = userNameFilter(filter);
      if (userName === undefined) {
        return scimError(
          c,
          400,
          'Only `userName eq "…"` is supported.',
          "invalidFilter",
        );
      }
      const found = await ctx.stores.scim.users.findByUserName(
        organization.id,
        userName,
      );
      resources = found ? [found] : [];
    }

    return scimBody(c, 200, {
      schemas: [LIST_SCHEMA],
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
      Resources: resources.map((user) => userResource(ctx, user)),
    });
  });

  routes.get("/:organizationId/scim/v2/Users/:id", async (c) => {
    const session = await authenticate(c);
    if (session instanceof Response) return session;
    const { ctx, organization } = session;
    const user = await ctx.stores.scim.users.getById(
      organization.id,
      c.req.param("id") ?? "",
    );
    if (!user) return scimError(c, 404, "User not found.");
    return scimBody(c, 200, userResource(ctx, user));
  });

  routes.patch("/:organizationId/scim/v2/Users/:id", async (c) => {
    const session = await authenticate(c);
    if (session instanceof Response) return session;
    const { ctx, organization } = session;

    const user = await ctx.stores.scim.users.getById(
      organization.id,
      c.req.param("id") ?? "",
    );
    if (!user) return scimError(c, 404, "User not found.");
    const body = await readScimJsonBody(c);
    if (!body) return scimError(c, 400, "Body is not a SCIM PatchOp.");

    const patch = foldUserPatch(scimPatchOperations(body));
    if (patch.userName && patch.userName !== user.userName) {
      const clash = await ctx.stores.scim.users.findByUserName(
        organization.id,
        patch.userName,
      );
      if (clash && clash.id !== user.id) {
        return scimError(
          c,
          409,
          "A user with that userName already exists.",
          "uniqueness",
        );
      }
    }

    const next = {
      ...user,
      userName: patch.userName ?? user.userName,
      active: patch.active ?? user.active,
      updatedAt: ctx.clock(),
      ...(patch.displayName !== undefined
        ? { displayName: patch.displayName }
        : undefined),
      ...(patch.externalId !== undefined
        ? { externalId: patch.externalId }
        : undefined),
    };
    const updated = await ctx.stores.scim.users.update(
      withRememberedSubjects(user, next),
    );

    if (user.active && !updated.active) {
      await deprovision(
        ctx,
        organization,
        updated,
        c.get("correlationId"),
        user,
      );
    }
    await appendAuditEvent(ctx.repos.auditEvents, {
      ...scimUserUpdateAudit(user.active, updated.active),
      outcome: "succeeded",
      organizationId: organization.id,
      correlationId: c.get("correlationId"),
      ...scimAuditActor(c),
      targetType: "scim_user",
      targetId: updated.id,
    });
    return scimBody(c, 200, userResource(ctx, updated));
  });

  /**
   * DELETE is deactivation, not erasure (D11). SCIM clients issue it as the
   * leaver signal, and the row has to survive: it is the record that this
   * subject must NOT be admitted, and deleting it would quietly re-open
   * JIT-join for the next assertion that arrives.
   */
  routes.delete("/:organizationId/scim/v2/Users/:id", async (c) => {
    const session = await authenticate(c);
    if (session instanceof Response) return session;
    const { ctx, organization } = session;

    const user = await ctx.stores.scim.users.getById(
      organization.id,
      c.req.param("id") ?? "",
    );
    if (!user) return scimError(c, 404, "User not found.");
    if (user.active) {
      const updated = await ctx.stores.scim.users.update({
        ...user,
        active: false,
        updatedAt: ctx.clock(),
      });
      await deprovision(ctx, organization, updated, c.get("correlationId"));
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.scim_user_deactivated",
        outcome: "succeeded",
        organizationId: organization.id,
        correlationId: c.get("correlationId"),
        ...scimAuditActor(c),
        targetType: "scim_user",
        targetId: updated.id,
        metadata: {
          action: "organization.scim_user.delete",
          state: "inactive",
        },
      });
    }
    return c.body(null, 204);
  });

  routes.patch("/:organizationId/scim/v2/Groups/:groupId", async (c) => {
    const session = await authenticate(c);
    if (session instanceof Response) return session;
    return patchScimGroup(c, session);
  });

  return routes;
}
