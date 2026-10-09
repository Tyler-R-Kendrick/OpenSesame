/**
 * Branded identifiers for the Identity API (ADR 0178).
 *
 * `PrincipalId` and every other id in `@opensesame/os-domain` is a plain
 * `string`, so a principal id and an organization id are interchangeable to the
 * compiler. A proof is about *which* value was checked, and `name()` can only
 * tell two values of one type apart by call site; a brand tells a person from an
 * organization before any proof is asked for. These are the only constructors,
 * and the only place a brand is asserted.
 */

declare const idBrand: unique symbol;

type Id<Kind extends string> = string & { readonly [idBrand]: Kind };

/** The authenticated principal making the request — never a path or body id. */
export type ActorId = Id<"actor">;
export type OrganizationId = Id<"organization">;
export type ProjectId = Id<"project">;

/**
 * The caller, from `c.get("principalId")`. Throws when `requirePrincipal()` did
 * not run, the same contract `authenticatedPrincipalId` states.
 */
export function actorId(value: string | undefined): ActorId {
  if (!value) throw new Error("requirePrincipal middleware invariant violated");
  /* SAFETY: `requirePrincipal()` sets `principalId` only after it checked a live session, so under that middleware contract a non-empty value is the authenticated principal. */
  return value as ActorId;
}

/** An organization id as the route names it; whether it exists is a proof's job. */
export function organizationId(value: string): OrganizationId {
  /* SAFETY: label only; the runtime string is unchanged, and whether it names a real, accessible row is the contract of the proofs in `proofs/`, the boundary where that is checked. */
  return value as OrganizationId;
}

/** A project id as the route names it; whether it exists is a proof's job. */
export function projectId(value: string): ProjectId {
  /* SAFETY: label only; the runtime string is unchanged, and whether it names a real, accessible row is the contract of the proofs in `proofs/`, the boundary where that is checked. */
  return value as ProjectId;
}

export type WebhookEndpointId = Id<"webhook-endpoint">;

/** A webhook endpoint id as the route names it; ownership is `ownsWebhook`'s job. */
export function webhookEndpointId(value: string): WebhookEndpointId {
  /* SAFETY: label only; the runtime string is unchanged, and whether the caller owns the endpoint is the contract of `ownsWebhook`, the boundary where that is checked. */
  return value as WebhookEndpointId;
}
