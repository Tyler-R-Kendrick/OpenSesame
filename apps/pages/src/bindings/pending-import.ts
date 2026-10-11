import {
  discardPendingImport,
  peekPendingImport,
  subscribePendingImport,
} from "@opensesame/app-core/lib/vault/pending-import.js";
import { useEffect, useSyncExternalStore } from "react";

/** The file chosen at the door for the vault about to be sealed, or null. */
export function usePendingImport(): File | null {
  return useSyncExternalStore(
    subscribePendingImport,
    peekPendingImport,
    () => null,
  );
}

/**
 * Whether a file is waiting for a vault that is yet to be sealed. A file held
 * for a vault that now exists and is locked is stale — that vault was sealed
 * and not opened — so it is let go. Never on "unlocked": the unlock ceremony
 * keeps the screen up for a moment after the seal, and the Import key is about
 * to take the file.
 */
export function useFileWaitingForVault(status: string): boolean {
  const waiting = usePendingImport() !== null;
  useEffect(() => {
    if (status === "locked") discardPendingImport();
  }, [status]);
  return waiting;
}
