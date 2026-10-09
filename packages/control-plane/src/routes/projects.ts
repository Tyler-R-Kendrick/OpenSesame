import { randomUUID } from "node:crypto";
import { appendAuditEvent, recordSecretChangelog } from "@opensesame/audit";
import {
  ActiveProjectResponseSchema,
  CreateProjectRequestSchema,
  CreateTemporaryProjectRequestSchema,
  CreateTemporaryProjectResponseSchema,
  ProjectMembershipResponseSchema,
  ProjectResponseSchema,
  SetActiveProjectRequestSchema,
} from "@opensesame/contracts";
import {
  type JsonObject,
  PERSONAL_PROJECT_SLUG,
  type Project,
  type ProjectMembership,
  type ProjectRole,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { claimLinks } from "../interactions/rendezvous.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { serializeKeyed } from "../serialize.js";
import { isVisible, roleFor } from "../services/project-access.js";
import {
  deleteProject,
  reconcileMembership,
  writeProject,
} from "../services/project-admin.js";
import { reconcileProjectAuthorityMembership } from "../services/project-membership-reconcile.js";
import { getUsage } from "../state.js";
import { authenticatedPrincipalId } from "./organizations.js";
import { asProjectMember } from "./project-role-gate.js";

export const projectRoutes = new Hono<{ Variables: Variables }>();

export function projectMembershipKey(
  projectId: string,
  principalId: string,
): string {
  return `${projectId}:${principalId}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function toResponse(project: Project, role: ProjectRole) {
  return ProjectResponseSchema.parse({
    id: project.id,
    kind: project.kind,
    slug: project.slug,
    displayName: project.displayName,
    state: project.state,
    role,
    ownerPrincipalId: project.ownerPrincipalId,
    organizationId: project.organizationId,
    expiresAt: project.expiresAt?.toISOString(),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  });
}

/** Hierarchy response plus opaque tomb/vault binding metadata (WP-B). */
function projectDetailResponse(project: Project, role: ProjectRole) {
  return {
    ...toResponse(project, role),
    sealedStoreTombName: project.sealedStoreTombName ?? null,
    pagesVaultFolderId: project.pagesVaultFolderId ?? null,
  };
}

function personalEnsureResponse(project: Project, created: boolean) {
  return {
    id: project.id,
    organizationId: project.organizationId ?? null,
    ownerPrincipalId: project.ownerPrincipalId ?? null,
    slug: project.slug,
    displayName: project.displayName,
    state: project.state,
    expiresAt: project.expiresAt?.toISOString() ?? null,
    claimPolicyId: project.claimPolicyId ?? null,
    sealedStoreTombName: project.sealedStoreTombName ?? null,
    pagesVaultFolderId: project.pagesVaultFolderId ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    created,
  };
}

export function membershipResponse(membership: ProjectMembership) {
  return ProjectMembershipResponseSchema.parse({
    ...membership,
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
  });
}

/**
 * Every principal has exactly one personal project — the default scope that
 * vaults, agents and sites land in until the caller swaps to another project.
 * Provisioned lazily on first touch rather than at signup so existing
 * principals pick one up too. The store's `ensurePersonal` is a single upsert
 * honoring the `projects_personal_owner_uidx` partial unique index.
 */
export async function ensurePersonalProject(
  ctx: AppContext,
  principalId: string,
): Promise<Project> {
  const { project } = await ctx.stores.projects.ensurePersonal(
    principalId,
    undefined,
    ctx.clock(),
  );
  return project;
}

/**
 * First-authenticated-session hook (WP-8): the moment a principal's session
 * stops being anonymous (their first verified identity link), their personal
 * project is ensured and the provisioning is recorded as a
 * `project.personal.ensured` changelog event through
 * {@link recordSecretChangelog} into the hash-chained audit trail. Idempotent:
 * a later session finds the project already present and records nothing.
 */
export async function ensurePersonalOnAuthenticatedSession(
  ctx: AppContext,
  principalId: string,
  correlationId?: string,
): Promise<Project> {
  const { project, created } = await ctx.stores.projects.ensurePersonal(
    principalId,
    undefined,
    ctx.clock(),
  );
  if (created) {
    await recordSecretChangelog(ctx.repos.auditEvents, {
      eventType: "project.personal.ensured",
      outcome: "succeeded",
      projectId: project.id,
      principalId,
      actorType: "human",
      ...(correlationId !== undefined ? { correlationId } : undefined),
      metadata: { action: "project.personal.ensure", slug: project.slug },
    });
  }
  return project;
}

/**
 * The project new resources land in: the principal's swapped-in active
 * project when it is still visible to them, else their personal project.
 */
export async function resolveActiveProject(
  ctx: AppContext,
  principalId: string,
): Promise<Project> {
  const personal = await ensurePersonalProject(ctx, principalId);
  const activeId = ctx.stores.activeProjects.get(principalId);
  if (activeId) {
    const project = await ctx.stores.projects.get(activeId);
    if (
      project &&
      (await roleFor(ctx, project, principalId)) &&
      isVisible(project, ctx.clock())
    ) {
      return project;
    }
    ctx.stores.activeProjects.delete(principalId);
  }
  return personal;
}

/** Projects the principal can see: memberships plus membership-less owned ones. */
async function visibleProjects(
  ctx: AppContext,
  principalId: string,
  now: Date,
): Promise<Array<{ project: Project; role: ProjectRole }>> {
  const seen = new Map<string, { project: Project; role: ProjectRole }>();
  for (const membership of await ctx.stores.projectMemberships.listByPrincipal(
    principalId,
  )) {
    const project = await ctx.stores.projects.get(membership.projectId);
    if (!project || !isVisible(project, now)) continue;
    seen.set(project.id, { project, role: membership.role });
  }
  for (const project of await ctx.stores.projects.listByOwner(principalId)) {
    if (project.kind !== "temporary") continue;
    if (seen.has(project.id) || !isVisible(project, now)) continue;
    seen.set(project.id, { project, role: "owner" });
  }
  return [...seen.values()];
}

projectRoutes.get("/", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  await ensurePersonalProject(ctx, principalId);
  const projects = (await visibleProjects(ctx, principalId, ctx.clock()))
    .sort((a, b) => {
      // Personal project first, then newest first — the swap list order.
      if (a.project.kind === "personal") return -1;
      if (b.project.kind === "personal") return 1;
      return b.project.createdAt.getTime() - a.project.createdAt.getTime();
    })
    .map(({ project, role }) => toResponse(project, role));
  return c.json({ projects });
});

projectRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("projects.create"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const rawBody = overlapCast(await c.req.json());
    const parsed = CreateProjectRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    return serializeKeyed(
      ctx.stores.principalMutations,
      principalId,
      async () => {
        const principal = await ctx.repos.principals.getById(principalId);
        if (!principal) {
          return c.json({ error: "not_found" }, 404);
        }

        const decision = ctx.policy.evaluate(
          principal,
          {
            subject: {
              type: "principal",
              id: principal.id,
              assurance: principal.assurance,
            },
            action: "project.create",
            resource: { type: "project", id: "*" },
          },
          await getUsage(ctx.stores, principalId, ctx.clock()),
        );
        if (decision.effect === "deny") {
          return c.json({ error: "forbidden", reasons: decision.reasons }, 403);
        }

        if (parsed.data.organizationId) {
          const membership = await ctx.stores.organizationMemberships.find(
            parsed.data.organizationId,
            principalId,
          );
          const organization = await ctx.stores.organizations.get(
            parsed.data.organizationId,
          );
          if (
            !organization ||
            organization.state === "deleted" ||
            !membership
          ) {
            return c.json({ error: "organization_not_found" }, 404);
          }
        }

        const now = ctx.clock();
        const derivedSlug = slugify(parsed.data.displayName);
        const slug =
          parsed.data.slug ??
          (derivedSlug.length > 0
            ? derivedSlug
            : `project-${randomUUID().slice(0, 8)}`);
        if (slug === PERSONAL_PROJECT_SLUG) {
          return c.json(
            {
              error: "validation_error",
              message:
                "Use POST /v1/projects/personal/ensure for the personal project",
            },
            400,
          );
        }
        const slugTaken = (await visibleProjects(ctx, principalId, now)).some(
          ({ project }) => project.slug === slug,
        );
        if (slugTaken) {
          return c.json({ error: "slug_taken" }, 409);
        }

        const project: Project = {
          id: `prj_${randomUUID()}`,
          kind: "standard",
          slug,
          displayName: parsed.data.displayName,
          state: "active",
          ownerPrincipalId: principalId,
          createdAt: now,
          updatedAt: now,
          ...(parsed.data.organizationId !== undefined
            ? { organizationId: parsed.data.organizationId }
            : undefined),
        };
        const tomb = isString(rawBody.sealedStoreTombName)
          ? rawBody.sealedStoreTombName.trim()
          : "";
        if (tomb) project.sealedStoreTombName = tomb;
        const folder = isString(rawBody.pagesVaultFolderId)
          ? rawBody.pagesVaultFolderId.trim()
          : "";
        if (folder) project.pagesVaultFolderId = folder;

        await ctx.stores.projects.set(project.id, project);
        await ctx.stores.projectMemberships.upsert({
          projectId: project.id,
          principalId,
          role: "owner",
          createdAt: now,
          updatedAt: now,
        });
        await reconcileProjectAuthorityMembership(ctx, project.id, {
          actorPrincipalId: principalId,
          correlationId: c.get("correlationId"),
        });

        await appendAuditEvent(ctx.repos.auditEvents, {
          eventType: "project.created",
          outcome: "succeeded",
          principalId,
          projectId: project.id,
          correlationId: c.get("correlationId"),
          metadata: { action: "project.create", slug: project.slug },
        });

        return c.json(projectDetailResponse(project, "owner"), 201);
      },
    );
  },
);

projectRoutes.get("/active", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  // resolveActiveProject drops a stale selection, so a surviving entry means
  // the caller explicitly swapped to this project rather than falling back.
  const project = await resolveActiveProject(ctx, principalId);
  const isFallback = ctx.stores.activeProjects.get(principalId) === undefined;
  const role = (await roleFor(ctx, project, principalId)) ?? "owner";
  return c.json(
    ActiveProjectResponseSchema.parse({
      project: toResponse(project, role),
      isFallback,
    }),
  );
});

projectRoutes.put("/active", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const parsed = SetActiveProjectRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", details: parsed.error.flatten() },
      400,
    );
  }
  const project = await ctx.stores.projects.get(parsed.data.projectId);
  const role = project && (await roleFor(ctx, project, principalId));
  if (!project || !role || !isVisible(project, ctx.clock())) {
    return c.json({ error: "not_found" }, 404);
  }
  ctx.stores.activeProjects.set(principalId, project.id);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "project.switched",
    outcome: "succeeded",
    principalId,
    projectId: project.id,
    correlationId: c.get("correlationId"),
    metadata: { action: "project.switch" },
  });
  return c.json(
    ActiveProjectResponseSchema.parse({
      project: toResponse(project, role),
      isFallback: false,
    }),
  );
});

projectRoutes.post(
  "/personal/ensure",
  requirePrincipal(),
  idempotencyMiddleware("projects.personal.ensure"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const principal = await ctx.repos.principals.getById(principalId);
    if (!principal) {
      return c.json({ error: "not_found" }, 404);
    }

    const { project, created } = await ctx.stores.projects.ensurePersonal(
      principalId,
      undefined,
      ctx.clock(),
    );

    if (created) {
      // The durable changelog path: same event, same redaction allowlist as
      // appendAuditEvent, but fenced to the frozen changelog vocabulary.
      await recordSecretChangelog(ctx.repos.auditEvents, {
        eventType: "project.personal.ensured",
        outcome: "succeeded",
        principalId,
        projectId: project.id,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "project.personal.ensure",
          slug: project.slug,
        },
      });
    }

    return c.json(
      personalEnsureResponse(project, created),
      created ? 201 : 200,
    );
  },
);

projectRoutes.post(
  "/temporary",
  requirePrincipal(),
  idempotencyMiddleware("projects.temporary"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const principal = await ctx.repos.principals.getById(principalId);
    if (!principal) {
      return c.json({ error: "not_found" }, 404);
    }

    const parsed = CreateTemporaryProjectRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    const decision = ctx.policy.evaluate(
      principal,
      {
        subject: {
          type: "principal",
          id: principal.id,
          assurance: principal.assurance,
        },
        action: "project.create_temporary",
        resource: { type: "project", id: "*" },
      },
      await getUsage(ctx.stores, principalId, ctx.clock()),
    );
    if (decision.effect === "deny") {
      return c.json({ error: "forbidden", reasons: decision.reasons }, 403);
    }

    const now = ctx.clock();
    const ttlSeconds = parsed.data.ttlSeconds ?? 86_400;
    const projectId = `prj_${randomUUID()}`;
    const derivedSlug = slugify(parsed.data.name);
    const slug =
      parsed.data.slug ??
      (derivedSlug.length > 0 ? derivedSlug : `temp-${projectId.slice(4, 12)}`);
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const project: Project = {
      id: projectId,
      kind: "temporary",
      slug,
      displayName: parsed.data.name,
      state: "provisional",
      ownerPrincipalId: principalId,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.stores.projects.set(projectId, project);

    const claim = await ctx.claims.createClaim({
      type: "project",
      targetManifest: {
        projectId,
        slug,
        displayName: project.displayName,
        ownerPrincipalId: principalId,
      },
      creatorPrincipalId: principalId,
      ttlMs: Math.min(ttlSeconds * 1000, 600_000),
    });

    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "project.temporary_created",
      outcome: "succeeded",
      principalId,
      projectId,
      claimId: claim.session.id,
      correlationId: c.get("correlationId"),
      metadata: { action: "project.create_temporary", state: "provisional" },
    });

    const body = CreateTemporaryProjectResponseSchema.parse({
      projectId,
      state: "provisional",
      displayName: project.displayName,
      expiresAt: expiresAt.toISOString(),
      claimId: claim.session.id,
      claimToken: claim.token,
      userCode: claim.userCode,
      ...claimLinks(ctx.config, claim),
      targetManifestDigest: claim.session.targetManifestDigest,
    });

    return c.json(body, 201);
  },
);

projectRoutes.get("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const project = await ctx.stores.projects.get(c.req.param("id"));
  const role = project && (await roleFor(ctx, project, principalId));
  if (!project || !role || !isVisible(project, ctx.clock())) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(projectDetailResponse(project, role));
});

const TOMB_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const FOLDER_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

/**
 * Copy the patchable fields of a JSON body onto `next`; returns the
 * `validation_error` message for the first invalid one. `null` or a blank
 * string clears an opaque binding.
 */
function applyProjectPatch(
  next: Project,
  body: JsonObject,
): string | undefined {
  if (isString(body.displayName)) {
    const displayName = body.displayName.trim();
    if (!displayName || displayName.length > 128) return "invalid displayName";
    next.displayName = displayName;
  }
  const bindings = [
    ["sealedStoreTombName", TOMB_NAME],
    ["pagesVaultFolderId", FOLDER_ID],
  ] as const;
  for (const [field, pattern] of bindings) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null) {
      Reflect.deleteProperty(next, field);
      continue;
    }
    if (!isString(value)) return `invalid ${field}`;
    const trimmed = value.trim();
    if (!trimmed) {
      Reflect.deleteProperty(next, field);
    } else if (!pattern.test(trimmed) || trimmed.includes("..")) {
      return `invalid ${field}`;
    } else {
      next[field] = trimmed;
    }
  }
  return undefined;
}

projectRoutes.patch("/:id", requirePrincipal(), (c) =>
  asProjectMember(
    c,
    // PATCH has never taken the per-project lock, unlike DELETE. A stale
    // `{...project}` write can therefore race a DELETE; recorded in ADR 0178
    // rather than changed here, so this refactor alters no behavior.
    { serialize: false },
    async ({ ctx, actor, project: named, access }) => {
      if (access.role === "member") {
        return c.json({ error: "admin_required" }, 403);
      }
      const { project, role } = access;

      const next: Project = { ...project, updatedAt: ctx.clock() };
      const invalid = applyProjectPatch(next, overlapCast(await c.req.json()));
      if (invalid) {
        return c.json({ error: "validation_error", message: invalid }, 400);
      }
      await writeProject(ctx, named, access.admin, next);
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "project.updated",
        outcome: "succeeded",
        principalId: actor.value,
        projectId: project.id,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "project.patch",
          displayName: next.displayName,
        },
      });
      return c.json(projectDetailResponse(next, role));
    },
  ),
);

projectRoutes.delete("/:id", requirePrincipal(), (c) =>
  asProjectMember(
    c,
    { serialize: true },
    async ({ ctx, actor, project, access }) => {
      if (access.role !== "owner") {
        return c.json({ error: "owner_required" }, 403);
      }
      if (access.project.kind === "personal") {
        // The default scope must always exist — it can be neither shared nor deleted.
        return c.json({ error: "personal_project_immutable" }, 409);
      }
      await deleteProject(ctx, project, access.owner, access.project);
      await reconcileMembership(
        ctx,
        actor,
        project,
        access.member,
        c.get("correlationId"),
      );
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "project.deleted",
        outcome: "succeeded",
        principalId: actor.value,
        projectId: project.value,
        correlationId: c.get("correlationId"),
        metadata: { action: "project.delete", kind: access.project.kind },
      });
      return c.body(null, 204);
    },
  ),
);
