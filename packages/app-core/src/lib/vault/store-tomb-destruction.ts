/** Destruction queues behind writes, then takes the original OPEN/BODY lease order. */
import { kvDeleteDurable } from "../kv.js";
import { HEADER_PATH, deletePlaintextFile } from "../vfs.js";
import type { VaultScope } from "./store-scope.js";
import type { StoreWriteQueue } from "./store-write-queue.js";
import { discardVaultBody, wipeTombOnDestroy } from "./tomb-migration.js";
import {
  withBodyWriteLock,
  withExclusiveOpenLease,
} from "./vault-shared-locks.js";
export async function destroyStoredTomb(
  queue: StoreWriteQueue,
  scope: VaultScope,
): Promise<void> {
  const done = queue
    .pending()
    .catch(() => undefined)
    .then(() =>
      withExclusiveOpenLease(scope.tomb, () =>
        withBodyWriteLock(scope.tomb, async () => {
          // The header is the tomb's recoverability marker. Delete it last:
          // a failed body or key wipe must leave a header that still says a
          // vault exists, never an empty store a later create can overwrite.
          // Its shared-index refresh must finish before the wipe deletes it.
          await discardVaultBody(scope.tomb);
          await Promise.all([
            kvDeleteDurable(scope.attempts),
            wipeTombOnDestroy(scope.tomb),
          ]);
          await deletePlaintextFile(scope.tomb, HEADER_PATH);
        }),
      ),
    );
  queue.assign(done);
  await done;
}
