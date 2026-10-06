/**
 * What a principal may see of a project, and the per-project mutation lock.
 *
 * These lived in `routes/projects.ts`. They move here so the `ProjectMember`
 * family of proofs (`proofs/project-role.ts`) and the routes can both use them
 * without the proof module importing a route (ADR 0178).
 */

import type { Project, ProjectRole } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/** States a caller can still see and act on. */
const VISIBLE_PROJECT_STATES = new Set(["provisional", "active"]);

export function isVisible(project: Project, now: Date): boolean {
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
  ctx: Pick<AppContext, "stores">,
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
export async function serializeProjectMutation<T>(
  ctx: Pick<AppContext, "stores">,
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
