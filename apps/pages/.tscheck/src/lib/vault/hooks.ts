import type { VaultItem } from "./model.js";

export type VaultState = {
  status: "empty" | "locked" | "unlocked";
  header: unknown;
  items: VaultItem[];
  folders: unknown[];
  prefs: unknown;
  lockedOutUntil: number | null;
  failedAttempts: number;
};

export function useVault(): VaultState {
  return {
    status: "empty",
    header: null,
    items: [],
    folders: [],
    prefs: null,
    lockedOutUntil: null,
    failedAttempts: 0,
  };
}
