import { isBoolean, isNumber } from "@opensesame/os-domain";
import { estimateStrength } from "./password.js";

export type VaultPrefs = {
  /** Minutes of inactivity before the vault locks. 0 disables the timer. */
  autoLockMinutes: number;
  /** Lock as soon as the tab is hidden. */
  lockOnHide: boolean;
  /**
   * When true, vault lock also ends the Identity session.
   * Off by default — idle vault lock should not sign you out of everything.
   */
  signOutOnLock: boolean;
  /** Seconds before a copied secret is cleared from the clipboard. 0 disables. */
  clipboardClearSeconds: number;
  theme: "system" | "light" | "dark";
  /**
   * Bumped when defaults change so existing devices pick up a one-time
   * migration (e.g. retiring the old 15-minute auto-lock default).
   */
  prefsRevision?: number;
};

/** Current prefs schema revision — bump when shipping a one-time prefs migrate. */
export const VAULT_PREFS_REVISION = 2;

export const defaultPrefs: VaultPrefs = {
  // Off by default: closing the window already drops the key from memory.
  // Operators who want idle lock opt in under Settings → General → Locking.
  autoLockMinutes: 0,
  lockOnHide: false,
  signOutOnLock: false,
  clipboardClearSeconds: 30,
  theme: "system",
  prefsRevision: VAULT_PREFS_REVISION,
};

/** Merge stored prefs with defaults and apply one-time migrations. */
export function normalizeVaultPrefs(
  raw: Partial<VaultPrefs> | null | undefined,
): VaultPrefs {
  const incoming = raw ?? {};
  const merged: VaultPrefs = {
    ...defaultPrefs,
    ...incoming,
    prefsRevision: Math.max(
      Number(incoming.prefsRevision ?? 0) || 0,
      VAULT_PREFS_REVISION,
    ),
  };
  // Revision 2: prior default was 15 min auto-lock — migrate to off.
  const priorRevision = Number(incoming.prefsRevision ?? 0) || 0;
  if (priorRevision < 2 && incoming.autoLockMinutes === 15) {
    merged.autoLockMinutes = 0;
  }
  if (!isBoolean(merged.signOutOnLock)) {
    merged.signOutOnLock = false;
  }
  if (
    !isNumber(merged.autoLockMinutes) ||
    !Number.isFinite(merged.autoLockMinutes) ||
    merged.autoLockMinutes < 0
  ) {
    merged.autoLockMinutes = 0;
  }
  return merged;
}

/** Create and re-key share one policy so a change cannot weaken the KDF input. */
export function assertMasterPasswordPolicy(password: string): void {
  if (password.length < 12) {
    throw new Error(
      "Use at least 12 characters. This key protects everything.",
    );
  }
  if (estimateStrength(password).score < 2) {
    throw new Error(
      "That master password is too easy to guess. Aim for Fair or better.",
    );
  }
}
