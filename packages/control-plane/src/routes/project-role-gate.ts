/**
 * Runs a project route handler under the proofs the caller's role earns
 * (ADR 0178).
 *
 * `name()` scopes the actor and the project to one callback, and the handler is
 * generic in those names, so it cannot return or store them. Mutations pass
 * `serialize: true`: the per-project lock stays outermost and the proof is
 * minted inside it, against the row the mutation will actually see.
 */

import type { Named } from "@gdp-ts/core";
import { name } from "@gdp-ts/core";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import {
  type ActorId,
  type ProjectId,
  actorId,
  projectId,
} from "../lib/ids.js";
import type { Variables } from "../middleware/context.js";
import { type ProjectAccess, projectAccess } from "../proofs/project-role.js";
import { serializeProjectMutation } from "../services/project-access.js";

export interface ProjectGate<A, P> {
  readonly ctx: AppContext;
  readonly actor: Named<A, ActorId>;
  readonly project: Named<P, ProjectId>;
  /** Narrow on `access.role` to reach `admin` / `owner`. */
  readonly access: ProjectAccess<A, P>;
}

export type ProjectHandler<R> = <A, P>(gate: ProjectGate<A, P>) => Promise<R>;

/** A caller with no visible role on the project gets `404 not_found`, as before. */
export async function asProjectMember<R>(
  c: Context<{ Variables: Variables }>,
  options: { readonly serialize: boolean },
  handler: ProjectHandler<R>,
): Promise<R | Response> {
  const ctx = c.get("ctx");
  const run = () =>
    name(
      actorId(c.get("principalId")),
      projectId(c.req.param("id") ?? ""),
      async (actor, project) => {
        const verdict = await projectAccess(ctx, actor, project);
        if (!verdict.ok)
          return c.json({ error: verdict.error }, verdict.status);
        return handler({ ctx, actor, project, access: verdict });
      },
    );
  return options.serialize
    ? serializeProjectMutation(ctx, c.req.param("id") ?? "", run)
    : run();
}
