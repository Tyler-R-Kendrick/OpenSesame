/**
 * `VerifiedPrincipal<A>` — the actor named `A` is a stored principal whose
 * assurance is not `provisional` (ADR 0178).
 *
 * Five routes wrote this check by hand (`oauth-clients`, `app-claims`,
 * `authentication-service`, organization creation, and a variant in
 * principals), each with its own message. The check lives here once; what a
 * refusal *says* stays with the route, so this returns a verdict naming why,
 * never a response. A principal the store does not know is `not_found`, a
 * provisional one is `provisional`; one route reads both as a single 403, the
 * others split them into 404 and 403 `assurance_too_low`.
 */

import { type Named, type Proof, defineProof } from "@gdp-ts/core";
import type { Principal } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import type { ActorId } from "../lib/ids.js";

const VerifiedPrincipal = defineProof("VerifiedPrincipal");
export interface VerifiedPrincipal<A> extends Proof<"VerifiedPrincipal", [A]> {}

export type VerifiedRefusalReason = "not_found" | "provisional";

export type VerifiedPrincipalVerdict<A> =
  | {
      readonly ok: true;
      readonly proof: VerifiedPrincipal<A>;
      readonly principal: Principal;
    }
  | { readonly ok: false; readonly reason: VerifiedRefusalReason };

export async function verifiedPrincipal<A>(
  repos: Pick<AppContext["repos"], "principals">,
  actor: Named<A, ActorId>,
): Promise<VerifiedPrincipalVerdict<A>> {
  const principal = await repos.principals.getById(actor.value);
  if (!principal) return { ok: false, reason: "not_found" };
  if (principal.assurance === "provisional") {
    return { ok: false, reason: "provisional" };
  }
  return { ok: true, proof: VerifiedPrincipal.prove(actor), principal };
}
