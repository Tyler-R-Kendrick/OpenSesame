/**
 * Minimum Access RBAC for the local Identity/Access plane.
 *
 * Organization membership still uses owner | admin | member (ADR 0105). This
 * module maps those onto Access roles operators configure in practice:
 * Operator (owner/admin), Member, and Guest. Guest is any unclaimed
 * `Guest N` / legacy guest person — never an operator once a claimed person
 * holds owner/admin.
 */

import {
  type LocalDirectory,
  LocalDirectoryError,
  type LocalIdentity,
  readLocalDirectory,
} from "./local-directory.js";
import {
  guestMembershipError,
  hasClaimedOperatorEntry,
  isGuestPersonEntry,
} from "./local-guest.js";
import { vaultStore } from "./vault/store.js";

export type AccessRole = "operator" | "member" | "guest";

export type AccessCapability =
  | "manage_grants"
  | "manage_policies"
  | "manage_identity"
  | "manage_memberships";

const OPERATOR_CAPABILITIES = [
  "manage_grants",
  "manage_policies",
  "manage_identity",
  "manage_memberships",
] as const satisfies readonly AccessCapability[];

const MEMBER_CAPABILITIES: readonly AccessCapability[] = [];

const ROLE_CAPABILITIES = {
  operator: OPERATOR_CAPABILITIES,
  member: MEMBER_CAPABILITIES,
  guest: MEMBER_CAPABILITIES,
} as const satisfies Record<AccessRole, readonly AccessCapability[]>;

export function isGuestIdentity(entry: LocalIdentity): boolean {
  return isGuestPersonEntry(entry);
}

export function accessRoleLabel(role: AccessRole): string {
  if (role === "operator") return "Operator";
  if (role === "guest") return "Guest";
  return "Member";
}

/** Organization role wording that surfaces the Access operator distinction. */
export function organizationRoleLabel(
  role: "owner" | "admin" | "member",
): string {
  if (role === "owner") return "Owner (operator)";
  if (role === "admin") return "Admin (operator)";
  return "Member";
}

export function hasClaimedOperator(directory: LocalDirectory): boolean {
  return hasClaimedOperatorEntry(directory.entries, directory.memberships);
}

export function resolveAccessRole(
  directory: LocalDirectory,
  principalId: string,
): AccessRole | null {
  const entry = directory.entries.find((row) => row.id === principalId);
  if (!entry || (entry.kind !== "person" && entry.kind !== "agent"))
    return null;
  if (entry.kind === "person" && isGuestIdentity(entry)) return "guest";
  if (entry.kind === "agent") return "member";
  const membership = directory.memberships.find(
    (row) => row.principalId === principalId,
  );
  if (!membership) return null;
  if (membership.role === "owner" || membership.role === "admin")
    return "operator";
  return "member";
}

export function canAccess(
  role: AccessRole,
  capability: AccessCapability,
): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Who is acting in this unlocked vault. A guest session is Operator only
 * while no claimed (non-guest) owner/admin exists — so a first-run guest can
 * set up Access, then loses operator powers once an admin is assigned.
 */
export async function resolveCurrentAccessRole(
  tomb: string,
): Promise<AccessRole> {
  const directory = await readLocalDirectory(tomb);
  const claimed = hasClaimedOperator(directory);
  if (vaultStore.getSnapshot().guest) {
    // Sole guest setup can administer; once a claimed operator exists, stop.
    return claimed ? "guest" : "operator";
  }
  try {
    const { currentLocalIdentitySession, listLocalIdentitySessions } =
      await import("./local-sessions.js");
    for (const row of await listLocalIdentitySessions(tomb)) {
      const session = await currentLocalIdentitySession(tomb, row.principalId);
      if (session) {
        return resolveAccessRole(directory, session.principalId) ?? "member";
      }
    }
  } catch {
    /* no local identity session — vault custodian */
  }
  // Unlocked non-guest vault custodian administers Access.
  return "operator";
}

export async function assertAccessCapability(
  tomb: string,
  capability: AccessCapability,
): Promise<AccessRole> {
  const role = await resolveCurrentAccessRole(tomb);
  if (!canAccess(role, capability)) {
    throw new LocalDirectoryError(
      "Only an operator can change Access or Identity administration once an operator identity is assigned.",
    );
  }
  return role;
}

/** Refuse elevating the guest principal when a claimed operator path exists. */
export function assertGuestMembershipAllowed(
  directory: LocalDirectory,
  principalId: string,
  role: "owner" | "admin" | "member" | null,
): void {
  if (role === null) return;
  const entry = directory.entries.find((row) => row.id === principalId);
  if (!entry) return;
  const message = guestMembershipError(
    directory.entries,
    directory.memberships,
    entry,
    role,
  );
  if (message) throw new LocalDirectoryError(message);
}
