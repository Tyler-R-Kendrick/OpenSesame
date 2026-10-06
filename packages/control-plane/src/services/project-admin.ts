/**
 * Project and membership mutations, each demanding a proof about the exact
 * project it touches (ADR 0178).
 *
 * A route used to run its role check and then call a store with an id string,
 * and nothing tied the two together. These functions cannot be called without
 * the proof, and the proof cannot be about another project. Altering an owner
 * is its own function that wants a `ProjectOwner`, so "only an owner may mint,
 * demote or remove an owner" is a type, with a runtime guard behind it for the
 * one fact the types cannot see (the row being replaced is already an owner's).
 *
 * The stores underneath stay reachable (`ctx.stores`), so this is the path
 * routes take, not a seal. Reads, audit rows, request parsing and the
 * route-specific refusals (last owner, personal project) stay in the route.
 * Call these inside `serializeProjectMutation`, which `asProjectMember` does.
 */

import type { Named } from "@gdp-ts/core";
import type { Project, ProjectMembership } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import type { ActorId, ProjectId } from "../lib/ids.js";
import type {
  ProjectAdmin,
  ProjectMember,
  ProjectOwner,
} from "../proofs/project-role.js";
import { reconcileProjectAuthorityMembership } from "./project-membership-reconcile.js";

type Proj<P> = Named<P, ProjectId>;
type Ctx = Pick<AppContext, "stores">;

/** A membership an admin may write: it never names the owner role. */
export type NonOwnerMembership = ProjectMembership & {
  readonly role: "admin" | "member";
};

function sameProject(expected: ProjectId, other: string): void {
  if (other !== expected) {
    throw new Error("row is for a different project");
  }
}

async function assertNotOwner(
  ctx: Ctx,
  project: ProjectId,
  principalId: string,
): Promise<void> {
  const existing = await ctx.stores.projectMemberships.find(
    project,
    principalId,
  );
  if (existing?.role === "owner") {
    throw new Error("only an owner may change an owner's membership");
  }
}

async function removeAndForget(
  ctx: Ctx,
  project: ProjectId,
  principalId: string,
): Promise<void> {
  await ctx.stores.projectMemberships.remove(project, principalId);
  if (ctx.stores.activeProjects.get(principalId) === project) {
    ctx.stores.activeProjects.delete(principalId);
  }
}

export async function writeProject<A, P>(
  ctx: Ctx,
  project: Proj<P>,
  _proof: ProjectAdmin<A, P>,
  updated: Project,
): Promise<void> {
  sameProject(project.value, updated.id);
  await ctx.stores.projects.set(project.value, updated);
}

/** Soft-deletes the project and drops every membership and active selection. */
export async function deleteProject<A, P>(
  ctx: Pick<AppContext, "stores" | "clock">,
  project: Proj<P>,
  _proof: ProjectOwner<A, P>,
  existing: Project,
): Promise<void> {
  sameProject(project.value, existing.id);
  await ctx.stores.projects.set(project.value, {
    ...existing,
    state: "deleted",
    updatedAt: ctx.clock(),
  });
  await ctx.stores.projectMemberships.removeByProject(project.value);
  for (const [holder, activeId] of ctx.stores.activeProjects) {
    if (activeId === project.value) ctx.stores.activeProjects.delete(holder);
  }
}

export async function grantMembership<A, P>(
  ctx: Ctx,
  project: Proj<P>,
  _proof: ProjectAdmin<A, P>,
  membership: NonOwnerMembership,
): Promise<void> {
  sameProject(project.value, membership.projectId);
  await assertNotOwner(ctx, project.value, membership.principalId);
  await ctx.stores.projectMemberships.upsert(membership);
}

/** Mints, demotes or rewrites an owner: the one write that wants an owner. */
export async function grantOwnerMembership<A, P>(
  ctx: Ctx,
  project: Proj<P>,
  _proof: ProjectOwner<A, P>,
  membership: ProjectMembership,
): Promise<void> {
  sameProject(project.value, membership.projectId);
  await ctx.stores.projectMemberships.upsert(membership);
}

export async function revokeMembership<A, P>(
  ctx: Ctx,
  project: Proj<P>,
  _proof: ProjectAdmin<A, P>,
  principalId: string,
): Promise<void> {
  await assertNotOwner(ctx, project.value, principalId);
  await removeAndForget(ctx, project.value, principalId);
}

export function revokeOwnerMembership<A, P>(
  ctx: Ctx,
  project: Proj<P>,
  _proof: ProjectOwner<A, P>,
  principalId: string,
): Promise<void> {
  return removeAndForget(ctx, project.value, principalId);
}

/** Any member may remove themselves; the proof and the actor name one person. */
export function leaveProject<A, P>(
  ctx: Ctx,
  actor: Named<A, ActorId>,
  project: Proj<P>,
  _proof: ProjectMember<A, P>,
): Promise<void> {
  return removeAndForget(ctx, project.value, actor.value);
}

/** Re-derive the project's authority edges after a membership change. */
export function reconcileMembership<A, P>(
  ctx: AppContext,
  actor: Named<A, ActorId>,
  project: Proj<P>,
  _proof: ProjectMember<A, P>,
  correlationId: string | undefined,
): Promise<void> {
  return reconcileProjectAuthorityMembership(ctx, project.value, {
    actorPrincipalId: actor.value,
    ...(correlationId !== undefined ? { correlationId } : undefined),
  });
}
