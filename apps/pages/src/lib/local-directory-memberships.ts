import {
  type BoundaryValue,
  type OrganizationRole,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type LocalDirectory,
  type LocalDirectoryChange,
  LocalDirectoryError,
  type LocalIdentity,
  type LocalMembership,
} from "./local-directory-types.js";
import {
  demoteGuestOperators,
  guestMembershipError,
  isGuestPersonEntry,
} from "./local-guest.js";

function isRole(value: BoundaryValue): value is OrganizationRole {
  return value === "owner" || value === "admin" || value === "member";
}

export function isMembership(value: BoundaryValue): value is LocalMembership {
  return (
    isJsonObject(value) &&
    isString(value.organizationId) &&
    isString(value.principalId) &&
    isRole(value.role)
  );
}

function validateMemberships(
  entries: LocalIdentity[],
  memberships: LocalMembership[],
) {
  const ids = new Set<string>();
  if (memberships.length > 5000)
    throw new LocalDirectoryError(
      "The directory is limited to 5,000 memberships.",
    );
  for (const membership of memberships) {
    const org = entries.find((entry) => entry.id === membership.organizationId);
    const person = entries.find((entry) => entry.id === membership.principalId);
    const key = `${membership.organizationId}:${membership.principalId}`;
    if (
      ids.has(key) ||
      org?.kind !== "organization" ||
      !person ||
      (person.kind !== "person" && person.kind !== "agent") ||
      (person.kind === "agent" && membership.role !== "member")
    )
      throw new LocalDirectoryError("Invalid organization membership.");
    const guestError = guestMembershipError(
      entries,
      memberships,
      person,
      membership.role,
    );
    if (guestError) throw new LocalDirectoryError(guestError);
    ids.add(key);
  }
  requireOwners(entries, memberships, memberships);
}

function requireOwners(
  entries: LocalIdentity[],
  memberships: LocalMembership[],
  previous: LocalMembership[],
) {
  for (const organizationId of new Set(
    previous.map((row) => row.organizationId),
  )) {
    if (!entries.some((entry) => entry.id === organizationId)) continue;
    if (
      !memberships.some(
        (row) =>
          row.organizationId === organizationId &&
          row.role === "owner" &&
          entries.some(
            (entry) =>
              entry.id === row.principalId &&
              entry.kind === "person" &&
              entry.enabled,
          ),
      )
    )
      throw new LocalDirectoryError(
        "Keep an enabled person as organization owner before removing or disabling the last owner.",
      );
  }
}

export function changedMemberships(
  current: LocalDirectory,
  entries: LocalIdentity[],
  change: LocalDirectoryChange,
) {
  let memberships = current.memberships.filter(
    (row) =>
      entries.some((entry) => entry.id === row.organizationId) &&
      entries.some((entry) => entry.id === row.principalId),
  );
  if (change.action === "membership") {
    if (change.role !== null && !isRole(change.role))
      throw new LocalDirectoryError("Invalid organization role.");
    memberships = memberships.filter(
      (row) =>
        row.organizationId !== change.organizationId ||
        row.principalId !== change.principalId,
    );
    if (change.role !== null)
      memberships.push({
        organizationId: change.organizationId,
        principalId: change.principalId,
        role: change.role,
      });
    const promoted = entries.find((entry) => entry.id === change.principalId);
    if (
      change.role !== null &&
      (change.role === "owner" || change.role === "admin") &&
      promoted &&
      !isGuestPersonEntry(promoted)
    ) {
      const orgIds = new Set(
        memberships
          .map((row) => row.organizationId)
          .concat(change.organizationId),
      );
      for (const organizationId of orgIds) {
        memberships = demoteGuestOperators(
          entries,
          memberships,
          organizationId,
        );
      }
      for (const organizationId of orgIds) {
        const hasOwner = memberships.some(
          (row) =>
            row.organizationId === organizationId &&
            row.role === "owner" &&
            entries.some(
              (entry) =>
                entry.id === row.principalId &&
                entry.kind === "person" &&
                entry.enabled,
            ),
        );
        if (hasOwner) continue;
        memberships = memberships.filter(
          (row) =>
            !(
              row.organizationId === organizationId &&
              row.principalId === promoted.id
            ),
        );
        memberships.push({
          organizationId,
          principalId: promoted.id,
          role: "owner",
        });
      }
    }
  }
  validateMemberships(entries, memberships);
  requireOwners(entries, memberships, current.memberships);
  return memberships;
}

export function validateDirectoryMemberships(
  entries: LocalIdentity[],
  memberships: LocalMembership[],
) {
  validateMemberships(entries, memberships);
}
