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
  /** Accounts read with the methods of their credentials (ADR 0179). */
  items: VaultItem[];
  /** The items as sealed: an account holds no methods, its credentials sit beside it. */
  rawItems?: readonly VaultItem[];
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

/**
 * Where the session's guest flag is read from. `vault/store.ts` binds the
 * session store here as it loads, so readers such as `guest-isolation.ts`
 * stay leaf modules — importing the store statically closes an import cycle
 * (ADR 0133). Before the store loads there is no session, and it reads false.
 */
let readGuestSession: () => boolean = () => false;

/** Bind the session store's guest flag and return the store, for `export const vaultStore = …`. */
export function bindGuestSessionStore<
  T extends { getSnapshot(): { guest?: boolean } },
>(store: T): T {
  readGuestSession = () => store.getSnapshot().guest === true;
  return store;
}

/** True while the unlocked session is the isolated guest road. */
export function guestSessionActive(): boolean {
  return readGuestSession();
}

