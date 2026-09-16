import type { PrincipalId } from "../types.js";
import type { AccessDomainForest } from "./forest.js";
import { requireDomain } from "./forest.js";
import type { AccessRealm } from "./realm.js";
import {
  admitsSharing,
  assertAdmitsSharing,
  refuseAccessDomain,
} from "./realm.js";

/**
 * What a principal may do in a domain.
 *
 * The same three rungs as organization and ADR 0038 project memberships,
 * deliberately not a fourth vocabulary.
 */
export type DomainRole = "member" | "admin" | "owner";

/** Weakest rung first, so an index comparison *is* the ladder. */
export const DOMAIN_ROLE_LADDER = ["member", "admin", "owner"] as const;

/** How far an assignment reaches. */
export type ControlScope = "domain_only" | "subtree";

function rung(role: DomainRole): number {
  return DOMAIN_ROLE_LADDER.indexOf(role);
}

/** Whether `role` covers `wanted`. Owning implies administering, and so on. */
export function roleCovers(role: DomainRole, wanted: DomainRole): boolean {
  return rung(role) >= rung(wanted);
}

/**
 * Whether this role may create, rename, move and retire domains, and hand
 * control to others.
 */
export function canAdminister(role: DomainRole): boolean {
  return role === "owner" || role === "admin";
}

/** Whether this role may hand out ownership. Only an owner may. */
export function canTransferOwnership(role: DomainRole): boolean {
  return role === "owner";
}

/** One grant of control. */
export interface ControlAssignment {
  /**
   * The handle an operator revokes. An assignment without its own id can be
   * withdrawn only by describing it, which is how the wrong one gets withdrawn.
   */
  readonly id: string;
  readonly domainId: string;
  readonly principalId: PrincipalId;
  readonly role: DomainRole;
  readonly scope: ControlScope;
}

/**
 * The answer to "what may this principal do here", and where it came from.
 *
 * `viaDomainId` is the domain the winning assignment was made at, which is what
 * an operator needs in order to revoke it.
 */
export interface EffectiveControl {
  readonly domainId: string;
  readonly principalId: PrincipalId;
  readonly role: DomainRole;
  readonly viaDomainId: string;
}

/** Every control assignment in a realm, keyed by assignment id. */
export interface ControlIndex {
  readonly assignments: ReadonlyMap<string, ControlAssignment>;
}

export function emptyControlIndex(): ControlIndex {
  return { assignments: new Map() };
}

export function controlAt(
  index: ControlIndex,
  domainId: string,
): ControlAssignment[] {
  return [...index.assignments.values()].filter(
    (assignment) => assignment.domainId === domainId,
  );
}

/**
 * Record an assignment made by the platform or the realm's owner.
 *
 * The realm comes from the forest rather than a separate argument, so there is
 * no call shape that checks one realm's sharing rule while writing into
 * another realm's estate.
 */
export function insertControl(
  index: ControlIndex,
  forest: AccessDomainForest,
  assignment: ControlAssignment,
): ControlIndex {
  requireDomain(forest, assignment.domainId);
  if (index.assignments.has(assignment.id)) {
    throw refuseAccessDomain(
      "conflict",
      `Control assignment ${assignment.id} already exists`,
      { id: assignment.id },
    );
  }
  const held = controlAt(index, assignment.domainId).some(
    (existing) => existing.principalId === assignment.principalId,
  );
  if (held) {
    throw refuseAccessDomain(
      "conflict",
      `${assignment.principalId} already holds control at ${assignment.domainId}`,
      { principalId: assignment.principalId, domainId: assignment.domainId },
    );
  }
  assertRealmAdmits(index, forest.realm, assignment.principalId);
  const assignments = new Map(index.assignments);
  assignments.set(assignment.id, assignment);
  return { assignments };
}

/**
 * Record an assignment one principal is handing to another.
 *
 * Delegation never widens: without this check an admin could mint an owner
 * below themselves and take the estate.
 */
export function insertDelegatedControl(
  index: ControlIndex,
  forest: AccessDomainForest,
  grantor: PrincipalId,
  assignment: ControlAssignment,
): ControlIndex {
  const held = effectiveControl(index, forest, assignment.domainId, grantor);
  if (held === undefined) {
    throw refuseAccessDomain(
      "control_widen",
      `${grantor} holds no control at ${assignment.domainId}`,
      { grantor, domainId: assignment.domainId },
    );
  }
  if (!canAdminister(held.role)) {
    throw refuseAccessDomain(
      "control_widen",
      `${grantor} is only a ${held.role} at ${assignment.domainId}`,
      { grantor, role: held.role },
    );
  }
  if (!roleCovers(held.role, assignment.role)) {
    throw refuseAccessDomain(
      "control_widen",
      `${grantor} holds ${held.role} and cannot grant ${assignment.role}`,
      { grantor, held: held.role, granting: assignment.role },
    );
  }
  if (
    canTransferOwnership(assignment.role) &&
    !canTransferOwnership(held.role)
  ) {
    throw refuseAccessDomain(
      "control_widen",
      `${grantor} cannot hand out ownership of ${assignment.domainId}`,
      { grantor, domainId: assignment.domainId },
    );
  }
  return insertControl(index, forest, assignment);
}

/** Withdraw an assignment. */
export function removeControl(index: ControlIndex, id: string): ControlIndex {
  const assignments = new Map(index.assignments);
  assignments.delete(id);
  return { assignments };
}

/**
 * What `principalId` may do at `domainId`, counting inherited control.
 *
 * Walks from the domain towards its root, taking the strongest role that
 * applies: assignments at the domain itself whatever their scope, and `subtree`
 * assignments from ancestors. The walk stops at an `isolated` domain, which is
 * what isolation means.
 */
export function effectiveControl(
  index: ControlIndex,
  forest: AccessDomainForest,
  domainId: string,
  principalId: PrincipalId,
): EffectiveControl | undefined {
  let best: EffectiveControl | undefined;
  const seen = new Set<string>();
  let cursor: string | undefined = domainId;
  let inherited = false;
  while (cursor !== undefined) {
    if (seen.has(cursor)) {
      throw refuseAccessDomain(
        "cycle",
        `Control walk from ${domainId} revisits ${cursor}`,
        { from: domainId, at: cursor },
      );
    }
    seen.add(cursor);
    const node = requireDomain(forest, cursor);
    for (const assignment of controlAt(index, cursor)) {
      if (assignment.principalId !== principalId) continue;
      if (inherited && assignment.scope !== "subtree") continue;
      if (best === undefined || rung(assignment.role) > rung(best.role)) {
        best = {
          domainId,
          principalId,
          role: assignment.role,
          viaDomainId: cursor,
        };
      }
    }
    if (node.inheritance === "isolated") break;
    cursor = node.parentId;
    inherited = true;
  }
  return best;
}

/** Refuse an administrative action by a principal who cannot administer. */
export function assertMayAdminister(
  index: ControlIndex,
  forest: AccessDomainForest,
  domainId: string,
  principalId: PrincipalId,
): EffectiveControl {
  const held = effectiveControl(index, forest, domainId, principalId);
  if (held !== undefined && canAdminister(held.role)) return held;
  throw refuseAccessDomain(
    "control_widen",
    `${principalId} cannot administer ${domainId}`,
    { principalId, domainId },
  );
}

/**
 * Refuse a second principal in a realm that does not share.
 *
 * ADR 0038's personal project refuses membership outright, so nesting domains
 * inside one cannot become a back door to sharing it.
 */
function assertRealmAdmits(
  index: ControlIndex,
  realm: AccessRealm,
  principalId: PrincipalId,
): void {
  if (admitsSharing(realm)) return;
  const stranger = [...index.assignments.values()].some(
    (existing) => existing.principalId !== principalId,
  );
  if (stranger) assertAdmitsSharing(realm, "a second controlling principal");
}
