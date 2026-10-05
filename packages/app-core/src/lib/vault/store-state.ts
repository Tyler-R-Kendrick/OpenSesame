/** The vault store's snapshot: what every surface reads about the open session. */

import type { Folder, VaultHeader, VaultItem } from "@opensesame/vault-core";
import type { VaultPrefs } from "./prefs.js";

export type VaultStatus = "empty" | "locked" | "unlocked";

export type VaultState = {
  status: VaultStatus;
  /** The tomb this session is scoped to — a project id, `personal`, or `guest`. */
  tomb: string;
  /** True while a guest session holds the key: never wrapped to disk. */
  guest: boolean;
  /**
   * True while the guest session is a duress decoy: isolated like any guest,
   * but drawn as the vault the unlock screen was showing, so nothing on screen
   * says which road opened it.
   */
  decoy?: boolean;
  header: VaultHeader | null;
  items: VaultItem[];
  folders: Folder[];
  prefs: VaultPrefs;
  /** Milliseconds until auto-lock, or null when no timer is armed. */
  lockedOutUntil: number | null;
  failedAttempts: number;
  /** Primary unlocked; second step enrolled but not yet confirmed. */
  awaitingSecondStep: boolean;
  /** False when storage is tab-only (no durable OPFS). */
  durable: boolean;
};
