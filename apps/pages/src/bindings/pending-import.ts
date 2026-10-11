import {
  peekPendingImport,
  subscribePendingImport,
} from "@opensesame/app-core/lib/vault/pending-import.js";
import { useSyncExternalStore } from "react";

/** The file chosen at the door for the vault about to be sealed, or null. */
export function usePendingImport(): File | null {
  return useSyncExternalStore(
    subscribePendingImport,
    peekPendingImport,
    () => null,
  );
}
