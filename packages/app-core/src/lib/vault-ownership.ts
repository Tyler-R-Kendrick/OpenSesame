/**
 * Transferring a vault's ownership to another registered user of that vault.
 *
 * The vault's owner is the person holding the `owner` role in its local
 * directory (ADR 0105). A transfer makes another registered person the owner
 * and leaves the previous owner an admin, the way GitHub's "Transfer
 * ownership" does. Recipients are the vault's own people: enabled persons, not
 * guest placeholders, never an agent, an application or an organization.
 *
 * This moves who administers the vault. It does not move the key: whoever is
 * to open the sealed vault still needs a key shared with them (ADR 0089).
 */

import {
  type LocalDirectory,
  LocalDirectoryError,
  type LocalIdentity,
  commitLocalDirectoryUnderLock,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { isGuestPersonEntry } from "./local-guest.js";
import {
  assertAccessCapability,
  canAccess,
  resolveCurrentAccessRole,
} from "./local-rbac.js";

/** A registered user: an enabled person who is not a guest placeholder. */
function isRegisteredUser(entry: LocalIdentity): boolean {
  return entry.kind === "person" && entry.enabled && !isGuestPersonEntry(entry);
}

/**
 * Enabled people holding the owner role in at least one organization. A vault
 * sealed without an account is owned by a guest-named placeholder, so this
 * does not require the owner to be a registered user: only a *recipient* must.
 */
export function vaultOwners(directory: LocalDirectory): LocalIdentity[] {
  const owners = new Set(
    directory.memberships
      .filter((row) => row.role === "owner")
      .map((row) => row.principalId),
  );
  return directory.entries.filter(
    (entry) => entry.kind === "person" && entry.enabled && owners.has(entry.id),
  );
}

/** Who a transfer from `fromId` may name: every other registered user. */
export function ownershipRecipients(
  directory: LocalDirectory,
  fromId: string,
): LocalIdentity[] {
  return directory.entries.filter(
    (entry) => isRegisteredUser(entry) && entry.id !== fromId,
  );
}

/**
 * The owner acting now: the signed-in local person when they own the vault,
 * else the only owner (the custodian of a vault with one). Undefined when the
 * actor is not an owner, or several owners leave it ambiguous.
 */
export async function actingOwner(
  tomb: string,
  directory: LocalDirectory,
): Promise<LocalIdentity | undefined> {
  const owners = vaultOwners(directory);
  try {
    const { currentLocalIdentitySession, listLocalIdentitySessions } =
      await import("./local-sessions.js");
    for (const row of await listLocalIdentitySessions(tomb)) {
      const session = await currentLocalIdentitySession(tomb, row.principalId);
      if (session) {
        return owners.find((owner) => owner.id === session.principalId);
      }
    }
  } catch {
    /* no local identity session: the vault custodian acts */
  }
  return owners.length === 1 ? owners[0] : undefined;
}

/**
 * Who the acting person may hand the vault to. Empty unless they own it *and*
 * this session may change memberships, so a surface that draws a key from this
 * never draws one that could only be refused (a guest session beside a claimed
 * owner reads as a guest, and `transferVaultOwnership` would turn it away).
 */
export async function transferRecipients(
  tomb: string,
  directory: LocalDirectory,
): Promise<LocalIdentity[]> {
  const owner = await actingOwner(tomb, directory);
  if (!owner) return [];
  const role = await resolveCurrentAccessRole(tomb);
  if (!canAccess(role, "manage_memberships")) return [];
  return ownershipRecipients(directory, owner.id);
}

/**
 * Make `toId` the owner of every organization the acting owner owns, then
 * leave the previous owner an admin there (a guest-named one a member). The recipient is promoted first, so
 * the directory never has no owner between the two writes.
 */
export async function transferVaultOwnership(
  tomb: string,
  toId: string,
): Promise<LocalDirectory> {
  await assertAccessCapability(tomb, "manage_memberships");
  // Who is acting is decided before the lock is taken: sessions read the
  // directory, and the lock is not reentrant (see `local-directory-admin.ts`).
  const from = await actingOwner(tomb, await readLocalDirectory(tomb));
  if (!from) {
    throw new LocalDirectoryError("Only the vault's owner can transfer it.");
  }
  return withLocalDirectoryLock(tomb, async () => {
    let current = await readLocalDirectory(tomb);
    if (!vaultOwners(current).some((owner) => owner.id === from.id)) {
      throw new LocalDirectoryError("Only the vault's owner can transfer it.");
    }
    const target = current.entries.find((entry) => entry.id === toId);
    if (!target || !isRegisteredUser(target)) {
      throw new LocalDirectoryError("Choose a registered user of this vault.");
    }
    if (target.id === from.id) {
      throw new LocalDirectoryError("That user already owns this vault.");
    }
    const owned = current.memberships.filter(
      (row) => row.principalId === from.id && row.role === "owner",
    );
    for (const row of owned) {
      current = await commitLocalDirectoryUnderLock(tomb, current.revision, {
        action: "membership",
        organizationId: row.organizationId,
        principalId: target.id,
        role: "owner",
      });
    }
    // Promoting a registered user already demotes a guest-named operator, and
    // a guest may not be an admin: demote only what is still an owner.
    const demoted = isGuestPersonEntry(from) ? "member" : "admin";
    for (const row of owned) {
      const stillOwner = current.memberships.some(
        (m) =>
          m.organizationId === row.organizationId &&
          m.principalId === from.id &&
          m.role === "owner",
      );
      if (!stillOwner) continue;
      current = await commitLocalDirectoryUnderLock(tomb, current.revision, {
        action: "membership",
        organizationId: row.organizationId,
        principalId: from.id,
        role: demoted,
      });
    }
    return current;
  });
}
