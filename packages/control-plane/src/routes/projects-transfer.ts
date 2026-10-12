/**
 * Transfer a project's ownership — the Danger zone's "Transfer ownership".
 *
 * Owner only, and only a standard project: the personal project must always
 * exist and a temporary one is claimed, not handed over. The vault key is not
 * part of this: the server moves the owner record, and whoever should open the
 * vault still needs the key shared with them.
 */

import { name } from "@gdp-ts/core";
import { appendAuditEvent } from "@opensesame/audit";
import {
  type TransferProjectRequest,
  TransferProjectRequestSchema,
} from "@opensesame/contracts";
import type { Project } from "@opensesame/os-domain";
import type { Context } from "hono";
import { organizationId } from "../lib/ids.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { orgOwner } from "../proofs/org-owner.js";
import type { ProjectOwner } from "../proofs/project-role.js";
import {
  reconcileMembership,
  transferProjectToOrganization,
  transferProjectToPrincipal,
} from "../services/project-admin.js";
import { type ProjectGate, asProjectMember } from "./project-role-gate.js";
import { projectDetailResponse, projectRoutes } from "./projects.js";

type Ctx = Context<{ Variables: Variables }>;
/** A refusal to send, or nothing when the step went through. */
type Step = Promise<Response | undefined>;

/** The personal project always exists; a temporary one is claimed, not given. */
function kindRefusal(c: Ctx, project: Project): Response | undefined {
  if (project.kind === "personal") {
    return c.json({ error: "personal_project_immutable" }, 409);
  }
  if (project.kind !== "standard") {
    return c.json({ error: "project_not_transferable" }, 409);
  }
  return undefined;
}

async function readRequest(
  c: Ctx,
  project: Project,
): Promise<TransferProjectRequest | Response> {
  const parsed = TransferProjectRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", details: parsed.error.flatten() },
      400,
    );
  }
  if (parsed.data.confirm !== project.slug) {
    return c.json({ error: "confirmation_mismatch" }, 400);
  }
  return parsed.data;
}

async function toPrincipal<A, P>(
  c: Ctx,
  gate: ProjectGate<A, P>,
  owner: ProjectOwner<A, P>,
  principalId: string,
): Step {
  const { ctx, actor, project, access } = gate;
  if (principalId === actor.value) {
    return c.json({ error: "already_owner" }, 409);
  }
  const principal = await ctx.repos.principals.getById(principalId);
  if (!principal) return c.json({ error: "principal_not_found" }, 404);
  // A provisional principal is a guest, not a registered user.
  if (principal.state !== "active") {
    return c.json({ error: "principal_inactive" }, 409);
  }
  const member = await ctx.stores.projectMemberships.find(
    project.value,
    principalId,
  );
  if (!member) return c.json({ error: "target_not_member" }, 409);
  await transferProjectToPrincipal(
    ctx,
    project,
    owner,
    access.project,
    actor,
    principalId,
  );
  return undefined;
}

function toOrganization<A, P>(
  c: Ctx,
  gate: ProjectGate<A, P>,
  owner: ProjectOwner<A, P>,
  target: string,
): Step {
  const { ctx, actor, project, access } = gate;
  return name(organizationId(target), async (org) => {
    const verdict = await orgOwner(ctx.stores, actor, org, "not_deleted");
    if (!verdict.ok) return c.json({ error: verdict.error }, verdict.status);
    if (access.project.organizationId === verdict.organization.id) {
      return c.json({ error: "already_in_organization" }, 409);
    }
    await transferProjectToOrganization(
      ctx,
      project,
      owner,
      verdict.proof,
      access.project,
      org,
    );
    return undefined;
  });
}

projectRoutes.post("/:id/transfer", requirePrincipal(), (c) =>
  asProjectMember(c, { serialize: true }, async (gate) => {
    const { ctx, actor, project, access } = gate;
    if (access.role !== "owner") {
      return c.json({ error: "owner_required" }, 403);
    }
    const refusal = kindRefusal(c, access.project);
    if (refusal) return refusal;
    const request = await readRequest(c, access.project);
    if (request instanceof Response) return request;
    const toUser = "principalId" in request;
    const failure = toUser
      ? await toPrincipal(c, gate, access.owner, request.principalId)
      : await toOrganization(c, gate, access.owner, request.organizationId);
    if (failure) return failure;
    await reconcileMembership(
      ctx,
      actor,
      project,
      access.member,
      c.get("correlationId"),
    );
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "project.transferred",
      outcome: "succeeded",
      principalId: actor.value,
      projectId: project.value,
      correlationId: c.get("correlationId"),
      metadata: {
        action: "project.transfer",
        ...(toUser
          ? { principalId: request.principalId }
          : { organizationId: request.organizationId }),
      },
    });
    const updated = await ctx.stores.projects.get(project.value);
    return c.json(
      projectDetailResponse(
        updated ?? access.project,
        toUser ? "admin" : "owner",
      ),
    );
  }),
);
