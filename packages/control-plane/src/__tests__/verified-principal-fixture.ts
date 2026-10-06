import { name } from "@gdp-ts/core";
import type { AppContext } from "../context.js";
import { actorId } from "../lib/ids.js";
import { verifiedPrincipal } from "../proofs/verified-principal.js";
import type { AppClaimService, StartedClaim } from "../services/app-claim.js";

/**
 * Start a claim the way a verified principal would: the proof comes from the
 * real prover, against the stored principal, never from a cast. A suite that
 * seeded a provisional (or no) principal fails here instead of claiming anyway.
 */
export async function startClaimAsVerified(
  ctx: AppContext,
  service: AppClaimService,
  principalId: string,
  applicationId: string,
): Promise<StartedClaim> {
  return name(actorId(principalId), async (actor) => {
    const verdict = await verifiedPrincipal(ctx.repos, actor);
    if (!verdict.ok) throw new Error(`not verified: ${verdict.reason}`);
    return service.startClaim(actor, verdict.proof, { applicationId });
  });
}
