/**
 * Mistakes the type checker must keep refusing (ADR 0178).
 *
 * Every `@ts-expect-error` below is a way to skip or misuse a project role
 * check. `tsc` fails the build if one of them starts to compile, so a change to
 * `Named`, the proofs or a guarded function that weakens the guarantee shows up
 * here before it reaches a route. Nothing in this file runs.
 */

import { name } from "@gdp-ts/core";
import type { AppContext } from "../context.js";
import { actorId, projectId } from "../lib/ids.js";
import {
  deleteProject,
  grantMembership,
  grantOwnerMembership,
  leaveProject,
  reconcileMembership,
  revokeMembership,
  writeProject,
} from "../services/project-admin.js";
import { projectAccess } from "./project-role.js";

export async function projectRoleMistakes(
  ctx: AppContext,
  membership: Parameters<typeof grantOwnerMembership>[3],
  adminGrant: Parameters<typeof grantMembership>[3],
  row: Parameters<typeof writeProject>[3],
): Promise<void> {
  await name(
    actorId("prn_1"),
    projectId("prj_a"),
    projectId("prj_b"),
    async (actor, projectA, projectB) => {
      const verdict = await projectAccess(ctx, actor, projectA);
      if (!verdict.ok) return;

      // The honest path compiles: proof about `projectA`, call about `projectA`.
      await leaveProject(ctx, actor, projectA, verdict.member);
      await reconcileMembership(ctx, actor, projectA, verdict.member, "c1");

      // @ts-expect-error — a proof about project A does not authorize project B.
      await leaveProject(ctx, actor, projectB, verdict.member);

      await name(actorId("prn_2"), async (other) => {
        // @ts-expect-error — a proof about actor A does not authorize actor B.
        await leaveProject(ctx, other, projectA, verdict.member);
      });

      // @ts-expect-error — no proof at all.
      await writeProject(ctx, projectA, undefined, row);

      // @ts-expect-error — a raw id string is not a named project.
      await leaveProject(ctx, actor, "prj_a", verdict.member);

      // @ts-expect-error — the verdict is not the proof; the refusal case must be handled first.
      await reconcileMembership(ctx, actor, projectA, verdict, "c1");

      // @ts-expect-error — a user id is not a project id.
      await projectAccess(ctx, actor, actor);

      if (verdict.role === "member") {
        // @ts-expect-error — a plain member carries no admin proof.
        await writeProject(ctx, projectA, verdict.admin, row);
        return;
      }

      await writeProject(ctx, projectA, verdict.admin, row);
      await grantMembership(ctx, projectA, verdict.admin, adminGrant);
      await revokeMembership(ctx, projectA, verdict.admin, "prn_3");

      // @ts-expect-error — an admin proof is not an owner proof: deleting needs an owner.
      await deleteProject(ctx, projectA, verdict.admin, row);

      // @ts-expect-error — an admin has no owner proof; only the owner verdict does.
      await grantOwnerMembership(ctx, projectA, verdict.owner, membership);

      if (verdict.role === "owner") {
        await deleteProject(ctx, projectA, verdict.owner, row);
        await grantOwnerMembership(ctx, projectA, verdict.owner, membership);

        // @ts-expect-error — an owner proof about project A does not delete project B.
        await deleteProject(ctx, projectB, verdict.owner, row);
      }

      const ownerRow = { ...adminGrant, role: "owner" as const };
      // @ts-expect-error — an admin may not write the owner role: it is not a NonOwnerMembership.
      await grantMembership(ctx, projectA, verdict.admin, ownerRow);
    },
  );

  // @ts-expect-error — a name cannot leave the callback it was created in.
  await name(actorId("prn_1"), projectId("prj_a"), (_a, p) => p);
}
