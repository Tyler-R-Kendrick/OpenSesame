/** Destruction remains behind every earlier persist of its captured scope. */
import { kvDeleteDurable } from "../kv.js";
import type { StoreWriteBarrier } from "../vfs-write-queue.js";
import { HEADER_PATH, deletePlaintextFile } from "../vfs.js";
import type { VaultScope } from "./store-scope.js";
import { discardVaultBody, wipeTombOnDestroy } from "./tomb-migration.js";
import {
  withBodyWriteLock,
  withExclusiveOpenLease,
} from "./vault-shared-locks.js";
export function queueStoreDestruction(
  chain: StoreWriteBarrier,
  scope: VaultScope,
): Promise<void> {
  return chain
    .catch(() => undefined)
    .then(async () => {
      // Awaited — leftover ciphertext would break a fresh vault.
      await withExclusiveOpenLease(scope.tomb, () =>
        withBodyWriteLock(scope.tomb, async () => {
          await Promise.all([
            deletePlaintextFile(scope.tomb, HEADER_PATH),
            discardVaultBody(scope.tomb),
            kvDeleteDurable(scope.attempts),
            wipeTombOnDestroy(scope.tomb),
          ]);
        }),
      );
    });
}
