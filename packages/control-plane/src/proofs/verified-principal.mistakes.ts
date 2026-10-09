/**
 * Mistakes the type checker must keep refusing (ADR 0178).
 *
 * Every `@ts-expect-error` below is a way to skip or misuse the verified-
 * identity check. `tsc` fails the build if one of them starts to compile.
 * Nothing in this file runs.
 */

import { name } from "@gdp-ts/core";
import type { AppContext } from "../context.js";
import { actorId } from "../lib/ids.js";
import type { AppClaimService } from "../services/app-claim.js";
import {
  createAuthenticationApplication,
  insertOAuthClient,
} from "../services/verified-admin.js";
import { verifiedPrincipal } from "./verified-principal.js";

export async function verifiedPrincipalMistakes(
  ctx: AppContext,
  claims: AppClaimService,
  client: Parameters<typeof insertOAuthClient>[3],
  app: Parameters<typeof createAuthenticationApplication>[3],
): Promise<void> {
  await name(actorId("prn_1"), actorId("prn_2"), async (alice, bob) => {
    const verdict = await verifiedPrincipal(ctx.repos, alice);
    if (!verdict.ok) return;

    // The honest path compiles: proof about `alice`, call for `alice`.
    await insertOAuthClient(ctx, alice, verdict.proof, client);
    await claims.startClaim(alice, verdict.proof, { applicationId: "cli_x" });

    // @ts-expect-error — a proof about alice does not authorize bob.
    await insertOAuthClient(ctx, bob, verdict.proof, client);

    // @ts-expect-error — no proof at all.
    await claims.startClaim(alice, { applicationId: "cli_x" });

    // @ts-expect-error — a raw principal id string is not a named actor.
    await claims.verifyAndClaim("prn_1", verdict.proof, { challenge: "c" });

    // @ts-expect-error — the verdict is not the proof; the refusal case must be handled first.
    await createAuthenticationApplication(ctx, alice, verdict, app);
  });

  // @ts-expect-error — a name cannot leave the callback it was created in.
  await name(actorId("prn_1"), (alice) => alice);
}
