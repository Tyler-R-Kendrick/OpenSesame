import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  ActiveProjectResponseSchema,
  AddProjectMemberRequestSchema,
  ChangeProjectMemberRoleRequestSchema,
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
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { serializeKeyed } from "../serialize.js";
import { getUsage } from "../state.js";
import { authenticatedPrincipalId } from "./organizations.js";

export const projectRoutes = new Hono<{ Variables: Variables }>();

/** States a caller can still see and act on. */
const VISIBLE_PROJECT_STATES = new Set(["provisional", "active"]);

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

function isVisible(project: Project, now: Date): boolean {
  if (!VISIBLE_PROJECT_STATES.has(project.state)) return false;
  if (project.expiresAt && project.expiresAt <= now) return false;
  return true;
}

/**
 * Role a principal holds on a project. Memberships are authoritative for
 * personal and standard projects (both mint an owner membership at creation,
 * so a removed membership means removed access). Temporary projects are
 * minted through the claims flow without a membership row, so their creating
 * principal resolves as owner via the ownership field instead.
 */
export async function roleFor(
  ctx: AppContext,
  project: Project,
  principalId: string,
): Promise<ProjectRole | undefined> {
  const membership = await ctx.stores.projectMemberships.find(
    project.id,
    principalId,
  );
  if (membership) return membership.role;
  if (
    project.kind === "temporary" &&
    project.ownerPrincipalId === principalId
  ) {
    return "owner";
  }
  return undefined;
}

/** Serialize membership mutations per project so checks and writes don't interleave. */
async function serializeProjectMutation<T>(
  ctx: AppContext,
  projectId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous =
    ctx.stores.projectMembershipMutations.get(projectId) ?? Promise.resolve();
  let release = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  ctx.stores.projectMembershipMutations.set(projectId, tail);
  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (ctx.stores.projectMembershipMutations.get(projectId) === tail) {
      ctx.stores.projectMembershipMutations.delete(projectId);
    }
  }
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

function membershipResponse(membership: ProjectMembership) {
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
          const membership = ctx.stores.organizationMemberships.get(
            `${parsed.data.organizationId}:${principalId}`,
          );
          const organization = ctx.stores.organizations.get(
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
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "project.personal.ensured",
        outcome: "succeeded",
        principalId,
        projectId: project.id,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "project.personal.ensure",
          slug: project.slug,
          sealedStoreTombName: project.sealedStoreTombName,
          pagesVaultFolderId: project.pagesVaultFolderId,
          created: true,
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
      verificationUri: `${ctx.config.publicUrl}/v1/claims/${claim.session.id}/verify`,
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

projectRoutes.patch("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const project = await ctx.stores.projects.get(c.req.param("id"));
  const role = project && (await roleFor(ctx, project, principalId));
  if (!project || !role || !isVisible(project, ctx.clock())) {
    return c.json({ error: "not_found" }, 404);
  }
  if (role === "member") {
    return c.json({ error: "admin_required" }, 403);
  }

  const body = overlapCast(await c.req.json());

  const tombName = /^[A-Za-z0-9._-]{1,64}$/;
  const folderId = /^[A-Za-z0-9._:/-]{1,128}$/;

  const next: Project = {
    ...project,
    updatedAt: ctx.clock(),
  };
  if (isString(body.displayName)) {
    const displayName = body.displayName.trim();
    if (!displayName || displayName.length > 128) {
      return c.json(
        { error: "validation_error", message: "invalid displayName" },
        400,
      );
    }
    next.displayName = displayName;
  }
  if (body.sealedStoreTombName !== undefined) {
    if (body.sealedStoreTombName === null) {
      Reflect.deleteProperty(next, "sealedStoreTombName");
    } else if (!isString(body.sealedStoreTombName)) {
      return c.json(
        { error: "validation_error", message: "invalid sealedStoreTombName" },
        400,
      );
    } else {
      const sealedStoreTombName = body.sealedStoreTombName.trim();
      if (!sealedStoreTombName) {
        Reflect.deleteProperty(next, "sealedStoreTombName");
      } else {
        if (
          !tombName.test(sealedStoreTombName) ||
          sealedStoreTombName.includes("..")
        ) {
          return c.json(
            {
              error: "validation_error",
              message: "invalid sealedStoreTombName",
            },
            400,
          );
        }
        next.sealedStoreTombName = sealedStoreTombName;
      }
    }
  }
  if (body.pagesVaultFolderId !== undefined) {
    if (body.pagesVaultFolderId === null) {
      Reflect.deleteProperty(next, "pagesVaultFolderId");
    } else if (!isString(body.pagesVaultFolderId)) {
      return c.json(
        { error: "validation_error", message: "invalid pagesVaultFolderId" },
        400,
      );
    } else {
      const pagesVaultFolderId = body.pagesVaultFolderId.trim();
      if (!pagesVaultFolderId) {
        Reflect.deleteProperty(next, "pagesVaultFolderId");
      } else {
        if (
          !folderId.test(pagesVaultFolderId) ||
          pagesVaultFolderId.includes("..")
        ) {
          return c.json(
            {
              error: "validation_error",
              message: "invalid pagesVaultFolderId",
            },
            400,
          );
        }
        next.pagesVaultFolderId = pagesVaultFolderId;
      }
    }
  }

  await ctx.stores.projects.set(project.id, next);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "project.updated",
    outcome: "succeeded",
    principalId,
    projectId: project.id,
    correlationId: c.get("correlationId"),
    metadata: {
      action: "project.patch",
      displayName: next.displayName,
    },
  });
  return c.json(projectDetailResponse(next, role));
});

projectRoutes.delete("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const projectId = c.req.param("id");
  return serializeProjectMutation(ctx, projectId, async () => {
    const project = await ctx.stores.projects.get(projectId);
    const role = project && (await roleFor(ctx, project, principalId));
    if (!project || !role || !isVisible(project, ctx.clock())) {
      return c.json({ error: "not_found" }, 404);
    }
    if (role !== "owner") {
      return c.json({ error: "owner_required" }, 403);
    }
    if (project.kind === "personal") {
      // The default scope must always exist — it can be neither shared nor deleted.
      return c.json({ error: "personal_project_immutable" }, 409);
    }
    const now = ctx.clock();
    await ctx.stores.projects.set(projectId, {
      ...project,
      state: "deleted",
      updatedAt: now,
    });
    await ctx.stores.projectMemberships.removeByProject(projectId);
    for (const [holder, activeId] of ctx.stores.activeProjects) {
      if (activeId === projectId) ctx.stores.activeProjects.delete(holder);
    }
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "project.deleted",
      outcome: "succeeded",
      principalId,
      projectId,
      correlationId: c.get("correlationId"),
      metadata: { action: "project.delete", kind: project.kind },
    });
    return c.body(null, 204);
  });
});

projectRoutes.get("/:id/members", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const project = await ctx.stores.projects.get(c.req.param("id"));
  const role = project && (await roleFor(ctx, project, principalId));
  if (!project || !role || !isVisible(project, ctx.clock())) {
    return c.json({ error: "not_found" }, 404);
  }
  if (role === "member") {
    return c.json({ error: "admin_required" }, 403);
  }
  const members = (
    await ctx.stores.projectMemberships.listByProject(project.id)
  ).map(membershipResponse);
  return c.json({ members });
});

projectRoutes.post("/:id/members", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const actorPrincipalId = authenticatedPrincipalId(c.get("principalId"));
  const projectId = c.req.param("id");
  return serializeProjectMutation(ctx, projectId, async () => {
    const project = await ctx.stores.projects.get(projectId);
    const actorRole =
      project && (await roleFor(ctx, project, actorPrincipalId));
    if (!project || !actorRole || !isVisible(project, ctx.clock())) {
      return c.json({ error: "not_found" }, 404);
    }
    if (actorRole === "member") {
      return c.json({ error: "admin_required" }, 403);
    }
    if (project.kind === "personal") {
      return c.json({ error: "personal_project_not_shareable" }, 409);
    }
    const parsed = AddProjectMemberRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    // Only an owner may mint another owner.
    if (parsed.data.role === "owner" && actorRole !== "owner") {
      return c.json({ error: "owner_required" }, 403);
    }
    const principal = await ctx.repos.principals.getById(
      parsed.data.principalId,
    );
    if (!principal) return c.json({ error: "principal_not_found" }, 404);
    if (principal.state === "suspended" || principal.state === "closed") {
      return c.json({ error: "principal_inactive" }, 409);
    }
    if (await ctx.stores.projectMemberships.find(projectId, principal.id)) {
      return c.json({ error: "membership_exists" }, 409);
    }
    const now = ctx.clock();
    const membership: ProjectMembership = {
      projectId,
      principalId: principal.id,
      role: parsed.data.role,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.stores.projectMemberships.upsert(membership);
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "project.member_added",
      outcome: "succeeded",
      principalId: actorPrincipalId,
      projectId,
      correlationId: c.get("correlationId"),
      metadata: {
        action: "project.member.add",
        memberPrincipalId: principal.id,
        role: membership.role,
      },
    });
    return c.json(membershipResponse(membership), 201);
  });
});

projectRoutes.patch(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const actorPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const projectId = c.req.param("id");
    return serializeProjectMutation(ctx, projectId, async () => {
      const project = await ctx.stores.projects.get(projectId);
      const actorRole =
        project && (await roleFor(ctx, project, actorPrincipalId));
      if (!project || !actorRole || !isVisible(project, ctx.clock())) {
        return c.json({ error: "not_found" }, 404);
      }
      if (actorRole === "member") {
        return c.json({ error: "admin_required" }, 403);
      }
      const targetPrincipalId = c.req.param("principalId");
      const target = await ctx.stores.projectMemberships.find(
        projectId,
        targetPrincipalId,
      );
      if (!target) return c.json({ error: "membership_not_found" }, 404);
      const parsed = ChangeProjectMemberRoleRequestSchema.safeParse(
        await c.req.json(),
      );
      if (!parsed.success) {
        return c.json(
          { error: "validation_error", details: parsed.error.flatten() },
          400,
        );
      }
      // Touching the owner role in either direction takes an owner actor.
      if (
        (target.role === "owner" || parsed.data.role === "owner") &&
        actorRole !== "owner"
      ) {
        return c.json({ error: "owner_required" }, 403);
      }
      if (target.role === parsed.data.role) {
        return c.json(membershipResponse(target));
      }
      if (
        target.role === "owner" &&
        (await ctx.stores.projectMemberships.countOwners(projectId)) === 1
      ) {
        return c.json({ error: "last_owner" }, 409);
      }
      const updated: ProjectMembership = {
        ...target,
        role: parsed.data.role,
        updatedAt: ctx.clock(),
      };
      await ctx.stores.projectMemberships.upsert(updated);
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "project.member_role_changed",
        outcome: "succeeded",
        principalId: actorPrincipalId,
        projectId,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "project.member.role.change",
          memberPrincipalId: targetPrincipalId,
          previousRole: target.role,
          role: updated.role,
        },
      });
      return c.json(membershipResponse(updated));
    });
  },
);

projectRoutes.delete(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const actorPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const projectId = c.req.param("id");
    return serializeProjectMutation(ctx, projectId, async () => {
      const project = await ctx.stores.projects.get(projectId);
      const actorRole =
        project && (await roleFor(ctx, project, actorPrincipalId));
      if (!project || !actorRole || !isVisible(project, ctx.clock())) {
        return c.json({ error: "not_found" }, 404);
      }
      const targetPrincipalId = c.req.param("principalId");
      const leavingSelf = targetPrincipalId === actorPrincipalId;
      if (actorRole === "member" && !leavingSelf) {
        return c.json({ error: "admin_required" }, 403);
      }
      const target = await ctx.stores.projectMemberships.find(
        projectId,
        targetPrincipalId,
      );
      if (!target) return c.json({ error: "membership_not_found" }, 404);
      if (target.role === "owner" && actorRole !== "owner") {
        return c.json({ error: "owner_required" }, 403);
      }
      if (
        target.role === "owner" &&
        (await ctx.stores.projectMemberships.countOwners(projectId)) === 1
      ) {
        return c.json({ error: "last_owner" }, 409);
      }
      if (project.kind === "personal") {
        return c.json({ error: "personal_project_immutable" }, 409);
      }
      await ctx.stores.projectMemberships.remove(projectId, targetPrincipalId);
      if (ctx.stores.activeProjects.get(targetPrincipalId) === projectId) {
        ctx.stores.activeProjects.delete(targetPrincipalId);
      }
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "project.member_removed",
        outcome: "succeeded",
        principalId: actorPrincipalId,
        projectId,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "project.member.remove",
          memberPrincipalId: targetPrincipalId,
          role: target.role,
        },
      });
      return c.body(null, 204);
    });
  },
);
