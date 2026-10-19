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
          await Promise.all([
            deletePlaintextFile(scope.tomb, HEADER_PATH),
            discardVaultBody(scope.tomb),
            kvDeleteDurable(scope.attempts),
            wipeTombOnDestroy(scope.tomb),
          ]);
        }),
      ),
    );
  queue.assign(done);
  await done;
}
