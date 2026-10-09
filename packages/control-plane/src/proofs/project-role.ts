/**
 * `ProjectMember`, `ProjectAdmin` and `ProjectOwner` — the actor named `A` holds
 * at least that role on the visible project named `P` (ADR 0178).
 *
 * This is the only module that can mint them. It replaces the
 * `roleFor` + `isVisible` + `role === "member"` block that every project and
 * membership handler repeated inline. One lookup yields the role, and the
 * verdict carries exactly the proofs that role earns: a `member` verdict has no
 * `admin` field, so a handler that forgot the 403 does not compile when it
 * reaches for an admin-only function.
 *
 * Wire behaviour is preserved by returning a verdict rather than throwing: a
 * project the caller has no role on, or that is deleted, provisional-expired or
 * otherwise not visible, is `404 not_found`. Whether a plain member is turned
 * away with `403 admin_required` or `403 owner_required` stays each route's
 * call, because the routes differ (a member may still leave a project).
 */

import { type Named, type Proof, defineProof } from "@gdp-ts/core";
import type { Project } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import type { ActorId, ProjectId } from "../lib/ids.js";
import { isVisible, roleFor } from "../services/project-access.js";

const ProjectMember = defineProof("ProjectMember");
const ProjectAdmin = defineProof("ProjectAdmin");
const ProjectOwner = defineProof("ProjectOwner");

/** The actor holds any role on the visible project. */
export interface ProjectMember<A, P> extends Proof<"ProjectMember", [A, P]> {}
/** The actor is an `admin` or `owner` of the visible project. */
export interface ProjectAdmin<A, P> extends Proof<"ProjectAdmin", [A, P]> {}
/** The actor is an `owner` of the visible project. */
export interface ProjectOwner<A, P> extends Proof<"ProjectOwner", [A, P]> {}

interface Access<A, P> {
  readonly ok: true;
  readonly project: Project;
  readonly member: ProjectMember<A, P>;
}

export type ProjectAccess<A, P> =
  | (Access<A, P> & { readonly role: "member" })
  | (Access<A, P> & {
      readonly role: "admin";
      readonly admin: ProjectAdmin<A, P>;
    })
  | (Access<A, P> & {
      readonly role: "owner";
      readonly admin: ProjectAdmin<A, P>;
      readonly owner: ProjectOwner<A, P>;
    });

export type ProjectVerdict<A, P> =
  | ProjectAccess<A, P>
  | {
      readonly ok: false;
      readonly status: 404;
      readonly error: "not_found";
    };

export async function projectAccess<A, P>(
  ctx: Pick<AppContext, "stores" | "clock">,
  actor: Named<A, ActorId>,
  project: Named<P, ProjectId>,
): Promise<ProjectVerdict<A, P>> {
  const row = await ctx.stores.projects.get(project.value);
  const role = row && (await roleFor(ctx, row, actor.value));
  if (!row || !role || !isVisible(row, ctx.clock())) {
    return { ok: false, status: 404, error: "not_found" };
  }
  const member = ProjectMember.prove(actor, project);
  if (role === "member") return { ok: true, role, project: row, member };
  const admin = ProjectAdmin.prove(actor, project);
  if (role === "admin") return { ok: true, role, project: row, member, admin };
  const owner = ProjectOwner.prove(actor, project);
  return { ok: true, role, project: row, member, admin, owner };
}
