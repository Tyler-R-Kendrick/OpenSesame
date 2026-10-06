/**
 * `OrgOwner<A, O>` — the actor named `A` holds the `owner` role in the live
 * organization named `O` (ADR 0178).
 *
 * This is the only module that can mint the proof: the prover stays private,
 * and `no-define-proof` / `no-exported-prover` hold the line. It replaces four
 * hand-written `requireOwner` helpers that each re-implemented the lookup, the
 * liveness test and the 404-versus-403 split, and drifted on the middle one.
 *
 * Wire behaviour is preserved by returning a verdict rather than throwing: an
 * organization the caller has no membership in is `404 not_found` (the id space
 * is not enumerable), a member who is not an owner is `403 owner_required`.
 */

import { type Named, type Proof, defineProof } from "@gdp-ts/core";
import type { Organization } from "@opensesame/os-domain";
import type { ActorId, OrganizationId } from "../lib/ids.js";
import type { AppStores } from "../state.js";

const OrgOwner = defineProof("OrgOwner");
export interface OrgOwner<A, O> extends Proof<"OrgOwner", [A, O]> {}

/**
 * Which organization states still let an owner act.
 *
 * `not_deleted` is what organizations, domains and LDAP have always accepted,
 * so a suspended organization's owner can still reach them to fix it.
 * `active` is the stricter reading SCIM provisioning has always used.
 * `unchecked` is what the membership routes in `routes/organizations.ts` have
 * always done: they never read the organization's state, so an owner of a
 * deleted organization can still list and edit members. That is recorded drift
 * (ADR 0178), kept so this change alters no behavior; it is not an endorsement.
 * They are named, not unified, because collapsing them would change who may
 * manage a suspended or deleted organization.
 */
export type OrgLiveness = "not_deleted" | "active" | "unchecked";

export type OrgOwnerVerdict<A, O> =
  | {
      readonly ok: true;
      readonly proof: OrgOwner<A, O>;
      readonly organization: Organization;
    }
  | {
      readonly ok: false;
      readonly status: 403 | 404;
      readonly error: "not_found" | "owner_required";
    };

export async function orgOwner<A, O>(
  stores: Pick<AppStores, "organizations" | "organizationMemberships">,
  actor: Named<A, ActorId>,
  org: Named<O, OrganizationId>,
  liveness: OrgLiveness,
): Promise<OrgOwnerVerdict<A, O>> {
  const organization = await stores.organizations.get(org.value);
  const membership = organization
    ? await stores.organizationMemberships.find(organization.id, actor.value)
    : undefined;
  const live =
    organization !== undefined &&
    (liveness === "unchecked" ||
      (liveness === "active"
        ? organization.state === "active"
        : organization.state !== "deleted"));
  if (!organization || !live || !membership) {
    return { ok: false, status: 404, error: "not_found" };
  }
  if (membership.role !== "owner") {
    return { ok: false, status: 403, error: "owner_required" };
  }
  return { ok: true, proof: OrgOwner.prove(actor, org), organization };
}
