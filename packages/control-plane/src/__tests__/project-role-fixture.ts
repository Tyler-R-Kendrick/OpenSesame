import type { Project, ProjectRole } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/** Seed a standard project with `members` (principal id -> role). */
export async function seedProject(
  ctx: AppContext,
  id: string,
  members: Readonly<Record<string, ProjectRole>>,
  overrides: Partial<Project> = {},
): Promise<Project> {
  const now = ctx.clock();
  const project: Project = {
    id,
    kind: "standard",
    slug: id,
    displayName: id,
    state: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await ctx.stores.projects.set(id, project);
  for (const [principalId, role] of Object.entries(members)) {
    await ctx.stores.projectMemberships.upsert({
      projectId: id,
      principalId,
      role,
      createdAt: now,
      updatedAt: now,
    });
  }
  return project;
}
