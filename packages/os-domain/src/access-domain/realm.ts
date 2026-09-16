import { DomainError } from "../errors.js";
import type { ProjectKind } from "../types.js";

/**
 * Every way an access-domain operation can be refused.
 *
 * The names mirror the `DomainError::AccessDomain*` variants in
 * `crates/domain/src/access_domain`, so a refusal means the same thing on both
 * planes and a test can prove the two lists have not drifted. `DomainError`'s
 * own code stays one of the existing ones; the reason is what says which rule
 * was broken.
 */
export const ACCESS_DOMAIN_REFUSALS = [
  "realm_mismatch",
  "cycle",
  "invalid",
  "not_found",
  "conflict",
  "depth_exceeded",
  "lifetime",
  "expired",
  "control_widen",
  "personal_sharing",
  "vault_binding",
] as const;

export type AccessDomainRefusal = (typeof ACCESS_DOMAIN_REFUSALS)[number];

/**
 * What a refusal may say about itself.
 *
 * A closed record rather than an open dictionary, and every field names an
 * entity or a count — a refusal identifies the domain, principal or slug at
 * fault, and can carry nothing that came out of a vault.
 */
export interface AccessDomainRefusalDetails {
  readonly id?: string;
  readonly parentId?: string;
  readonly domainId?: string;
  readonly principalId?: string;
  readonly grantor?: string;
  readonly slug?: string;
  readonly depth?: string;
  readonly children?: string;
  readonly vaultId?: string;
  readonly sealedAgainst?: string;
  readonly projectId?: string;
  readonly what?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly role?: string;
  readonly held?: string;
  readonly granting?: string;
  readonly from?: string;
  readonly at?: string;
}

/** The org/project boundary an access-domain forest is bound to. */
export interface AccessRealm {
  /** The organization above the project, when there is one (ADR 0038). */
  readonly organizationId?: string;
  readonly projectId: string;
  readonly projectKind: ProjectKind;
}

/**
 * Raise an access-domain refusal.
 *
 * Codes are reused from the shared `DomainErrorCode` union rather than
 * extended, because a caller branching on "conflict" or "not found" already
 * handles these correctly; `details.reason` is the precise rule.
 */
export function refuseAccessDomain(
  reason: AccessDomainRefusal,
  message: string,
  details: AccessDomainRefusalDetails = {},
): DomainError {
  switch (reason) {
    case "not_found":
      return new DomainError("NOT_FOUND", message, { reason, ...details });
    case "conflict":
      return new DomainError("CONFLICT", message, { reason, ...details });
    case "expired":
      return new DomainError("EXPIRED", message, { reason, ...details });
    default:
      return new DomainError("INVARIANT_VIOLATION", message, {
        reason,
        ...details,
      });
  }
}

/** Whether a second principal may ever hold authority in this project. */
export function admitsSharing(realm: AccessRealm): boolean {
  return realm.projectKind !== "personal";
}

/** Whether the project itself is on a clock. */
export function isTimeBoundRealm(realm: AccessRealm): boolean {
  return realm.projectKind === "temporary";
}

/** Whether two realms name the same org/project boundary. */
export function isSameBoundary(left: AccessRealm, right: AccessRealm): boolean {
  return (
    left.projectId === right.projectId &&
    left.organizationId === right.organizationId
  );
}

/**
 * Refuse anything from another realm.
 *
 * This is the check that makes cross-realm reparenting unreachable rather than
 * merely discouraged. A matching org/project pair that disagrees on kind is
 * also refused: the same project cannot be personal in one reading and standard
 * in another, so that combination is corrupt input rather than a crossing.
 */
export function assertSameBoundary(
  expected: AccessRealm,
  actual: AccessRealm,
): void {
  if (!isSameBoundary(expected, actual)) {
    throw refuseAccessDomain(
      "realm_mismatch",
      `Access domain belongs to project ${actual.projectId}, not ${expected.projectId}`,
      { expected: expected.projectId, actual: actual.projectId },
    );
  }
  if (expected.projectKind !== actual.projectKind) {
    throw refuseAccessDomain(
      "realm_mismatch",
      `Project ${expected.projectId} disagrees on kind: ${expected.projectKind} vs ${actual.projectKind}`,
      { expected: expected.projectKind, actual: actual.projectKind },
    );
  }
}

/** Refuse a sharing operation in a realm that does not share (ADR 0038). */
export function assertAdmitsSharing(realm: AccessRealm, what: string): void {
  if (admitsSharing(realm)) return;
  throw refuseAccessDomain(
    "personal_sharing",
    `Personal project ${realm.projectId} refuses ${what}`,
    { projectId: realm.projectId, what },
  );
}
