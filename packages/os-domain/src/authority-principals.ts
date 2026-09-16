/**
 * ID-BIND — Identity-plane principal classes for generalized authority.
 *
 * Inventory (existing types elsewhere in this package + database):
 * - `Principal` — canonical id; historically kindless (Better Auth / OIDC humans).
 * - `Agent` / `AgentRegistration` — agent *registration* (software identity).
 * - `AgentInstance` — actor instance (runtime key / PoP holder).
 * - `TrustSession.deviceId` — authenticated device session binding, not a resource.
 * - `deviceAuthorizationSessions` — RFC 8628 flow, not a device principal.
 * - `authority_membership_edges.subject_kind` — closed CHECK aligned below.
 *
 * Audience labels stay in templates. These kinds fence identity enrollment so a
 * person, registration, instance, workload, and device principal are not
 * interchangeable. Managed device *resources* are never principals.
 */

import { DomainError } from "./errors.js";
import type { SubjectKind } from "./trust.js";

/** Wire kinds that may sit on an Identity membership edge (DB CHECK). */
export const MEMBERSHIP_SUBJECT_KINDS = [
  "person",
  "service",
  "agent_registration",
  "workload_instance",
  "device",
] as const;

export type MembershipSubjectKind = (typeof MEMBERSHIP_SUBJECT_KINDS)[number];

/**
 * Full principal class set for ID-BIND. `actor_instance` is domain-only: an
 * instance is not cohort eligibility; membership edges use the subset above.
 */
export const AUTHORITY_PRINCIPAL_KINDS = [
  "person",
  "service",
  "agent_registration",
  "actor_instance",
  "workload_instance",
  "device",
] as const;

export type AuthorityPrincipalKind = (typeof AUTHORITY_PRINCIPAL_KINDS)[number];

/** A managed device as a *resource* is not an authenticated principal. */
export type ManagedDeviceResource = {
  readonly kind: "managed_device_resource";
  readonly resourceId: string;
  readonly realmId: string;
};

export type AuthorityPrincipalRef = {
  readonly kind: AuthorityPrincipalKind;
  readonly principalId: string;
  readonly realmId: string;
};

export type TypedAuthorityRelation =
  | "runs_on"
  | "managed_by"
  | "owned_by"
  | "member_of"
  | "acts_for";

export type AuthorityRelationEdge = {
  readonly relation: TypedAuthorityRelation;
  readonly from: AuthorityPrincipalRef | ManagedDeviceResource;
  readonly to: AuthorityPrincipalRef | ManagedDeviceResource;
};

export type ProofOfPossessionEnrollment = {
  readonly subjectKind: "actor_instance" | "device" | "workload_instance";
  readonly principalId: string;
  readonly publicKeyJkt: string;
  readonly boundAt: Date;
  readonly expiresAt?: Date;
  /** Host/Identity generation fence; restore must bump this, not reuse keys. */
  readonly authorityGeneration: number;
};

type RelationEnd = AuthorityPrincipalKind | "managed_device_resource";

const RELATION_ENDS = {
  runs_on: {
    from: new Set<RelationEnd>(["actor_instance", "workload_instance"]),
    to: new Set<RelationEnd>(["managed_device_resource", "device"]),
  },
  managed_by: {
    from: new Set<RelationEnd>([
      "managed_device_resource",
      "device",
      "workload_instance",
    ]),
    to: new Set<RelationEnd>(["person", "service", "agent_registration"]),
  },
  owned_by: {
    from: new Set<RelationEnd>([
      "agent_registration",
      "actor_instance",
      "workload_instance",
      "device",
      "managed_device_resource",
    ]),
    to: new Set<RelationEnd>(["person", "service"]),
  },
  member_of: {
    from: new Set<RelationEnd>([
      "person",
      "service",
      "agent_registration",
      "workload_instance",
      "device",
    ]),
    to: new Set<RelationEnd>(["person", "service"]),
  },
  acts_for: {
    from: new Set<RelationEnd>([
      "actor_instance",
      "workload_instance",
      "agent_registration",
    ]),
    to: new Set<RelationEnd>(["person", "service", "agent_registration"]),
  },
} as const satisfies Record<
  TypedAuthorityRelation,
  {
    readonly from: ReadonlySet<RelationEnd>;
    readonly to: ReadonlySet<RelationEnd>;
  }
>;

function endKind(
  end: AuthorityPrincipalRef | ManagedDeviceResource,
): RelationEnd {
  return end.kind;
}

function includesClosed<T extends string>(
  closed: readonly T[],
  value: string,
): value is T {
  for (const candidate of closed) {
    if (candidate === value) return true;
  }
  return false;
}

export function isAuthorityPrincipalKind(
  value: string,
): value is AuthorityPrincipalKind {
  return includesClosed(AUTHORITY_PRINCIPAL_KINDS, value);
}

export function isMembershipSubjectKind(
  value: string,
): value is MembershipSubjectKind {
  return includesClosed(MEMBERSHIP_SUBJECT_KINDS, value);
}

/**
 * Map coarse trust SubjectKind onto an authority principal class. Assurance
 * vectors stay on TrustSession; this only prevents silent widening at bind.
 */
export function authorityKindFromTrustSubject(
  subject: SubjectKind,
): AuthorityPrincipalKind {
  switch (subject) {
    case "human":
      return "person";
    case "agent":
      return "agent_registration";
    case "workload":
      return "workload_instance";
    default: {
      const _exhaustive: never = subject;
      return _exhaustive;
    }
  }
}

/**
 * Membership eligibility kinds are a subset. Actor instances never become
 * cohort members by re-labeling.
 */
export function toMembershipSubjectKind(
  kind: AuthorityPrincipalKind,
): MembershipSubjectKind {
  if (kind === "actor_instance") {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "actor_instance is not a membership subject kind",
      { kind },
    );
  }
  return kind;
}

/**
 * Refuse treating a managed device resource id as an authenticated principal.
 * Possession of a device record is not proof of human identity or safe sandbox.
 */
export function refuseDeviceResourceAsPrincipal(
  resource: ManagedDeviceResource,
): AuthorityPrincipalRef {
  throw new DomainError(
    "INVARIANT_VIOLATION",
    `managed device resource ${resource.resourceId} is not an authenticated principal`,
    { resourceId: resource.resourceId, realmId: resource.realmId },
  );
}

/**
 * Typed relation ends — kinds are not interchangeable across edges.
 * `member_of` never admits an actor_instance; `runs_on` never admits a person.
 */
export function assertAuthorityRelationAllowed(
  edge: AuthorityRelationEdge,
): void {
  const rule = RELATION_ENDS[edge.relation];
  const from = endKind(edge.from);
  const to = endKind(edge.to);
  if (!rule.from.has(from) || !rule.to.has(to)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      `relation ${edge.relation} refuses ends ${from} -> ${to}`,
      { relation: edge.relation, from, to },
    );
  }
  if (
    edge.from.kind !== "managed_device_resource" &&
    edge.to.kind !== "managed_device_resource" &&
    edge.from.principalId === edge.to.principalId &&
    edge.from.kind !== edge.to.kind
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "same principalId cannot carry two authority kinds on one edge",
      {
        principalId: edge.from.principalId,
        fromKind: edge.from.kind,
        toKind: edge.to.kind,
      },
    );
  }
}

/**
 * Proof-of-possession enrollment: bind a public key thumbprint to an instance
 * or device principal. Registration ids alone are not enough.
 */
export function bindProofOfPossession(input: {
  readonly subjectKind: ProofOfPossessionEnrollment["subjectKind"];
  readonly principalId: string;
  readonly publicKeyJkt: string;
  readonly authorityGeneration: number;
  readonly boundAt: Date;
  readonly expiresAt?: Date;
}): ProofOfPossessionEnrollment {
  if (input.principalId.length === 0) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "PoP enrollment requires a principal id",
      {},
    );
  }
  if (input.publicKeyJkt.length < 8) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "PoP enrollment requires a public key thumbprint",
      { principalId: input.principalId },
    );
  }
  if (
    !Number.isInteger(input.authorityGeneration) ||
    input.authorityGeneration < 1
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "PoP enrollment requires authorityGeneration >= 1",
      { authorityGeneration: input.authorityGeneration },
    );
  }
  if (
    input.expiresAt !== undefined &&
    input.expiresAt.getTime() <= input.boundAt.getTime()
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "PoP enrollment expiry must be after bind time",
      {},
    );
  }
  if (input.expiresAt !== undefined) {
    return {
      subjectKind: input.subjectKind,
      principalId: input.principalId,
      publicKeyJkt: input.publicKeyJkt,
      boundAt: input.boundAt,
      authorityGeneration: input.authorityGeneration,
      expiresAt: input.expiresAt,
    };
  }
  return {
    subjectKind: input.subjectKind,
    principalId: input.principalId,
    publicKeyJkt: input.publicKeyJkt,
    boundAt: input.boundAt,
    authorityGeneration: input.authorityGeneration,
  };
}
