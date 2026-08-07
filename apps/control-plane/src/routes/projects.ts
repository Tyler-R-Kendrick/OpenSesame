import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { appendAuditEvent } from "@opensesame/audit";
import {
  CreateTemporaryProjectRequestSchema,
  CreateTemporaryProjectResponseSchema,
} from "@opensesame/contracts";
import type { Project } from "@opensesame/os-domain";
import type { Variables } from "../middleware/context.js";
import { requirePrincipal } from "../middleware/auth.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { bumpUsage, getUsage } from "../state.js";

export const projectRoutes = new Hono<{ Variables: Variables }>();

projectRoutes.post(
  "/temporary",
  requirePrincipal(),
  idempotencyMiddleware("projects.temporary"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = c.get("principalId")!;
    const principal = await ctx.repos.principals.getById(principalId);
    if (!principal) {
      return c.json({ error: "not_found" }, 404);
    }

    const parsed = CreateTemporaryProjectRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error.flatten() }, 400);
    }

    const decision = ctx.policy.evaluate(
      principal,
      {
        subject: { type: "principal", id: principal.id, assurance: principal.assurance },
        action: "project.create_temporary",
        resource: { type: "project", id: "*" },
      },
      getUsage(ctx.stores, principalId),
    );
    if (decision.effect === "deny") {
      return c.json({ error: "forbidden", reasons: decision.reasons }, 403);
    }

    const now = ctx.clock();
    const ttlSeconds = parsed.data.ttlSeconds ?? 86_400;
    const projectId = `prj_${randomUUID()}`;
    const derivedSlug = parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    const slug =
      parsed.data.slug ??
      (derivedSlug.length > 0 ? derivedSlug : `temp-${projectId.slice(4, 12)}`);

    const project: Project = {
      id: projectId,
      slug,
      displayName: parsed.data.name,
      state: "provisional",
      ownerPrincipalId: principalId,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      createdAt: now,
      updatedAt: now,
    };
    ctx.stores.projects.set(projectId, project);

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

    bumpUsage(ctx.stores, principalId, { temporaryProjects: 1 });

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
      expiresAt: project.expiresAt!.toISOString(),
      claimId: claim.session.id,
      claimToken: claim.token,
      userCode: claim.userCode,
      verificationUri: `${ctx.config.publicUrl}/v1/claims/${claim.session.id}/verify`,
      targetManifestDigest: claim.session.targetManifestDigest,
    });

    return c.json(body, 201);
  },
);
