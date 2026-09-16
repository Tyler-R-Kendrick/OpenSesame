/**
 * Stable guest principal + membership rules shared by directory and Access RBAC.
 */

import type { OrganizationRole } from "@opensesame/os-domain";

export const GUEST_PERSON_ID = "local_00000000-0000-4000-8000-000000000003";
export const GUEST_PERSON_NAME = "guest@guest";

type IdentityRef = {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly enabled: boolean;
};

type MembershipRef = {
  readonly organizationId: string;
  readonly principalId: string;
  readonly role: OrganizationRole;
};

export function isGuestPersonEntry(entry: IdentityRef): boolean {
  return (
    entry.kind === "person" &&
    (entry.id === GUEST_PERSON_ID || entry.name === GUEST_PERSON_NAME)
  );
}

export function hasClaimedOperatorEntry(
  entries: readonly IdentityRef[],
  memberships: readonly MembershipRef[],
): boolean {
  return memberships.some(
    (row) =>
      (row.role === "owner" || row.role === "admin") &&
      entries.some(
        (entry) =>
          entry.id === row.principalId &&
          entry.kind === "person" &&
          entry.enabled &&
          !isGuestPersonEntry(entry),
      ),
  );
}

/** Refuse guest admin; refuse guest owner once a claimed operator exists. */
export function guestMembershipError(
  entries: readonly IdentityRef[],
  memberships: readonly MembershipRef[],
  person: IdentityRef,
  role: OrganizationRole,
): string | null {
  if (!isGuestPersonEntry(person)) return null;
  if (role === "admin") {
    return "Guest identities cannot be operators. Keep guest as Member and grant resources on Access.";
  }
  if (role === "owner" && hasClaimedOperatorEntry(entries, memberships)) {
    return "Guest identities cannot own the organization once an operator is assigned.";
  }
  return null;
}

/** When a claimed person becomes owner/admin, demote guest operators. */
export function demoteGuestOperators(
  entries: readonly IdentityRef[],
  memberships: readonly MembershipRef[],
  organizationId: string,
): MembershipRef[] {
  return memberships.map((row) => {
    if (row.organizationId !== organizationId) return row;
    const person = entries.find((entry) => entry.id === row.principalId);
    if (
      person &&
      isGuestPersonEntry(person) &&
      (row.role === "owner" || row.role === "admin")
    ) {
      return { ...row, role: "member" as const };
    }
    return row;
  });
}
