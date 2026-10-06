/**
 * Runs a route handler under an `OrgOwner` proof (ADR 0178).
 *
 * `name()` scopes the actor and the organization to one callback, and the
 * handler is generic in those names, so it cannot return or store them. Every
 * owner-fenced route in `organizations`, `org-domains`, `org-ldap` and `scim`
 * goes through here instead of carrying its own copy of the lookup.
 */

import type { Named } from "@gdp-ts/core";
import { name } from "@gdp-ts/core";
import type { Organization } from "@opensesame/os-domain";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import {
  type ActorId,
  type OrganizationId,
  actorId,
  organizationId,
} from "../lib/ids.js";
import type { Variables } from "../middleware/context.js";
import {
  type OrgLiveness,
  type OrgOwner,
  orgOwner,
} from "../proofs/org-owner.js";

export interface OrgOwnerGate<A, O> {
  readonly ctx: AppContext;
  readonly actor: Named<A, ActorId>;
  readonly org: Named<O, OrganizationId>;
  readonly proof: OrgOwner<A, O>;
  readonly organization: Organization;
}

export type OrgOwnerHandler<R> = <A, O>(gate: OrgOwnerGate<A, O>) => Promise<R>;

export interface OrgOwnerSource {
  /** The path parameter that names the organization (`id` or `organizationId`). */
  readonly param: string;
  readonly liveness: OrgLiveness;
}

/**
 * The refusal keeps the wire shape every route already had: `404 not_found`
 * for an organization the caller is not in, `403 owner_required` for a member
 * who is not an owner.
 */
export async function asOrgOwner<R>(
  c: Context<{ Variables: Variables }>,
  source: OrgOwnerSource,
  handler: OrgOwnerHandler<R>,
): Promise<R | Response> {
  const ctx = c.get("ctx");
  return name(
    actorId(c.get("principalId")),
    organizationId(c.req.param(source.param) ?? ""),
    async (actor, org) => {
      const verdict = await orgOwner(ctx.stores, actor, org, source.liveness);
      if (!verdict.ok) return c.json({ error: verdict.error }, verdict.status);
      return handler({
        ctx,
        actor,
        org,
        proof: verdict.proof,
        organization: verdict.organization,
      });
    },
  );
}
