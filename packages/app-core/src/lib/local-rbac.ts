/**
 * Minimum Access RBAC for the local Identity/Access plane.
 *
 * Organization membership still uses owner | admin | member (ADR 0105). This
 * module maps those onto Access roles operators configure in practice:
 * Operator (owner/admin), Member, and Guest. Guest is any unclaimed
 * `Guest N` / legacy guest person — never an operator once a claimed person
 * holds owner/admin.
 *
 * Duress (AUTH-B): active restricted/decoy fences demote effective role and
 * intersect IAM capabilities with incident deny ceilings. Guest onboarding
 * without an active fence is unchanged.
 */

import {
  type LocalDirectory,
  type LocalDirectoryChange,
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

async function readDuressFenceView(): Promise<{
  fence: import("./duress/session/fence.js").FenceState;
  ctx: import("./duress/access/context.js").AccessContext | null;
} | null> {
  try {
    const { duressSessionFence } = await import("./duress/session/fence.js");
    // Lost broadcasts: prefer durable fence before IAM decisions (AUTH-C).
    duressSessionFence.rehydrateFromDurable({ bumpIfChanged: false });
    const ctx = duressSessionFence.currentContext();
    return {
      fence: duressSessionFence.readFence(),
      ctx,
    };
  } catch {
    return null;
  }
}

/**
 * Who is acting in this unlocked vault. A guest session is Operator only
 * while no claimed (non-guest) owner/admin exists — so a first-run guest can
 * set up Access, then loses operator powers once an admin is assigned.
 *
 * Restricted/decoy/locked duress presentations never promote via missing
 * identity lookup (INV-11 / AUTH-B).
 */
function guestUnderActiveFence(
  fence: NonNullable<Awaited<ReturnType<typeof readDuressFenceView>>>["fence"],
  ctx: NonNullable<Awaited<ReturnType<typeof readDuressFenceView>>>["ctx"],
): boolean {
  if (fence.activeIncidentIds.length === 0) return false;
  if (!ctx) return true;
  return (
    ctx.claims.presentation === "restricted" ||
    ctx.claims.presentation === "decoy" ||
    ctx.claims.presentation === "locked" ||
    fence.retiredDevice
  );
}

export async function resolveCurrentAccessRole(
  tomb: string,
): Promise<AccessRole> {
  const duress = await readDuressFenceView();
  if (duress && guestUnderActiveFence(duress.fence, duress.ctx)) {
    return "guest";
  }

  let directory: LocalDirectory;
  try {
    directory = await readLocalDirectory(tomb);
  } catch (error) {
    // Directory failure: fail closed — never fall through to custodian operator
    // while a duress fence is active (AUTH-F). Guest onboarding without a fence
    // still needs directory; rethrow so callers surface the error.
    if (duress && duress.fence.activeIncidentIds.length > 0) {
      return "guest";
    }
    throw error;
  }

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

  // Unlocked non-guest vault custodian administers Access — unless a fence
  // deny ceiling stripped operator capabilities (still labeled operator only
  // when no restricted presentation; assertAccessCapability intersects).
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

  // AUTH-B: intersect with incident deny ceilings even if role stayed operator
  // (e.g. alert-only profile that denies mint_grant without decoy presentation).
  const duress = await readDuressFenceView();
  if (duress) {
    const { canAccessWithFence } = await import("./duress/access/iam.js");
    const ctx = duress.ctx;
    if (!canAccessWithFence(role, capability, duress.fence, ctx, canAccess)) {
      throw new LocalDirectoryError(
        "Access capability denied by active duress incident ceiling.",
      );
    }
  }

  return role;
}

/**
 * Who may make a directory change through the Identity/Access panel: records
 * (create, rename, enable, delete) are identity administration, memberships
 * are membership administration. Guest status is read from the display name,
 * so an unchecked rename would let a demoted guest turn the claimed owner
 * into a "guest" and so make itself operator — hence every rename is gated.
 */
export async function assertDirectoryChangeAllowed(
  tomb: string,
  change: LocalDirectoryChange,
): Promise<AccessRole> {
  return assertAccessCapability(
    tomb,
    change.action === "membership" ? "manage_memberships" : "manage_identity",
  );
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
