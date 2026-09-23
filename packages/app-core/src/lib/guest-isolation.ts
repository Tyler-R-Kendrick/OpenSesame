/**
 * Guest sessions are physically separate: `GUEST_TOMB`, ephemeral key, wiped
 * on lock. Member grants, Host installs, and audit logs live under member
 * tombs and must never be readable or manageable from a guest session.
 */

import { vaultStore } from "./vault/store.js";
import { GUEST_TOMB } from "./vfs.js";

/** True while the unlocked session is the isolated guest road. */
export function isGuestSession(): boolean {
  return vaultStore.getSnapshot().guest === true;
}

/** True when this tomb id is the guest isolation boundary. */
export function isGuestTomb(tomb: string): boolean {
  return tomb.trim() === GUEST_TOMB;
}

/**
 * Guest must not open member Host / Access administration surfaces.
 * Returns a display reason when blocked; `null` when the session may proceed.
 */
export function memberSurfaceBlockedReason(): string | null {
  if (!isGuestSession()) return null;
  return "Guest sessions use a separate vault. Member grants, Host installs, connection logs, and Access administration stay sealed with their owners.";
}

/** Refuse mutating member-facing Access/Host state from a guest session. */
export function assertNotGuestSession(action: string): void {
  if (!isGuestSession()) return;
  throw new Error(
    `Guests cannot ${action}. Continue in a member vault, or end the guest session.`,
  );
}
