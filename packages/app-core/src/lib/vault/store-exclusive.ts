import {
  type VaultBody,
  type VaultHeader,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import { isGuestSessionTomb } from "../duress/store/decoy-scratch.js";
import type { StoreWriteBarrier } from "../vfs-write-queue.js";
import type { ApplyChange } from "./store-device-key.js";
import { type FreshBody, freshBody } from "./store-fresh.js";
import { readTombHeader } from "./store-header.js";
import {
  pinStoredRootAuthority,
  refreshStoredRootProof,
} from "./store-root-authority.js";
/** Body writes retain the original admission through queueing and cross-tab locking. */
import { withBodyWriteLockOrBare } from "./vault-shared-locks.js";
type ExclusiveBodyHost = {
  read(): {
    key: CryptoKey | null;
    header: VaultHeader | null;
    body: VaultBody;
    mark: string | null;
    carries: boolean;
  };
  install(fresh: FreshBody): void;
  emit(): void;
  apply: ApplyChange;
  raw(): Uint8Array;
};
export async function queueExclusiveBodyWrite<T>(
  chain: StoreWriteBarrier,
  tomb: string,
  assertCurrent: () => void,
  host: ExclusiveBodyHost,
  act: (apply: ApplyChange) => Promise<T>,
): Promise<T> {
  assertCurrent();
  const originalKey = host.read().key;
  if (!originalKey) throw new Error("The vault is locked.");
  return chain.then(() => {
    assertCurrent();
    return withBodyWriteLockOrBare(tomb, async () => {
      assertCurrent();
      await refreshStoredRootProof(tomb, originalKey, host.raw, assertCurrent);
      assertCurrent();
      pinStoredRootAuthority(tomb, originalKey)();
      const held = host.read();
      if (!held.key) throw new Error("The vault is locked.");
      const fresh = await freshBody(tomb, held.key, held, () =>
        held.carries ? readTombHeader(tomb) : null,
      );
      assertCurrent();
      host.install(fresh);
      if (fresh.body) {
        syncInstalledTypes(fresh.body.itemTypes);
        host.emit();
      }
      const result = await act((change) => {
        assertCurrent();
        return host.apply(change);
      });
      assertCurrent();
      return result;
    });
  });
}

/** Scratch and ordinary guest bodies never participate in stored-vault carries. */
export function sharesBody(ephemeral: boolean, tomb: string): boolean {
  return !ephemeral && !isGuestSessionTomb(tomb);
}
