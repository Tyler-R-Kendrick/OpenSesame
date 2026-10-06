/**
 * Mistakes the type checker must keep refusing (ADR 0178).
 *
 * Every `@ts-expect-error` below is a way to skip or misuse the owner check.
 * `tsc` fails the build if one of them starts to compile, so a change to
 * `Named`, `OrgOwner` or a guarded function that weakens the guarantee shows up
 * here before it reaches a route. Nothing in this file runs.
 */

import { name } from "@gdp-ts/core";
import type { AppContext } from "../context.js";
import { actorId, organizationId } from "../lib/ids.js";
import { putLdapConfig, removeLdapConfig } from "../services/org-admin.js";
import { orgOwner } from "./org-owner.js";

export async function orgOwnerMistakes(
  ctx: AppContext,
  config: Parameters<typeof putLdapConfig>[3],
): Promise<void> {
  await name(
    actorId("prn_1"),
    organizationId("org:a"),
    organizationId("org:b"),
    async (actor, orgA, orgB) => {
      const verdict = await orgOwner(ctx.stores, actor, orgA, "not_deleted");
      if (!verdict.ok) return;

      // The honest path compiles: proof about `orgA`, call about `orgA`.
      await removeLdapConfig(ctx, orgA, verdict.proof);

      // @ts-expect-error — a proof about organization A does not authorize B.
      await removeLdapConfig(ctx, orgB, verdict.proof);

      // @ts-expect-error — no proof at all.
      await removeLdapConfig(ctx, orgA);

      // @ts-expect-error — a raw id string is not a named organization.
      await removeLdapConfig(ctx, "org:a", verdict.proof);

      // @ts-expect-error — the verdict is not the proof; the refusal case must be handled first.
      await putLdapConfig(ctx, orgA, verdict, config);

      // @ts-expect-error — a user id is not an organization id.
      await orgOwner(ctx.stores, actor, actor, "not_deleted");
    },
  );

  // @ts-expect-error — a name cannot leave the callback it was created in.
  await name(actorId("prn_1"), organizationId("org:a"), (_actor, orgA) => orgA);
}
