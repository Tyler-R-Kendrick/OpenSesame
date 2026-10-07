/** Load and migrate a vault's sealed preferences during session activation. */
import { overlapCast } from "@opensesame/os-domain";
import { type StoreWriteBarrier, trackSealedWork } from "../vfs-write-queue.js";
import { VfsError } from "../vfs.js";
import { readPrefsJson, writePrefsJson } from "./prefs-io.js";
import {
  VAULT_PREFS_REVISION,
  type VaultPrefs,
  normalizeVaultPrefs,
} from "./prefs.js";
import { refreshStoredRootProof } from "./store-root-authority.js";

export async function loadSessionPrefs(
  tomb: string,
  fallback: VaultPrefs,
  assertCurrent: () => void,
): Promise<VaultPrefs> {
  assertCurrent();
  try {
    const stored: Partial<VaultPrefs> = overlapCast(await readPrefsJson(tomb));
    assertCurrent();
    const prefs = normalizeVaultPrefs(stored);
    if ((stored.prefsRevision ?? 0) < VAULT_PREFS_REVISION) {
      await writePrefsJson(tomb, prefs).catch(() => {
        assertCurrent();
      });
      assertCurrent();
    }
    return prefs;
  } catch (error) {
    assertCurrent();
    if (error instanceof VfsError && error.code === "locked") throw error;
    return fallback;
  }
}

type PrefsOwner = {
  root: readonly [key: CryptoKey, raw: () => Uint8Array];
  current(): VaultPrefs;
  restore(prefs: VaultPrefs): void;
};
/** Queue metadata under the original key; failures cannot publish into a successor. */
export function queueSessionPrefs(
  chain: StoreWriteBarrier,
  tomb: string,
  prefs: VaultPrefs,
  assertCurrent: () => void,
  owner: PrefsOwner,
): Promise<void> {
  return trackSealedWork(
    chain
      .then(async () => {
        assertCurrent();
        await refreshStoredRootProof(
          tomb,
          owner.root[0],
          owner.root[1],
          assertCurrent,
        );
        assertCurrent();
        try {
          await writePrefsJson(tomb, prefs);
          assertCurrent();
        } catch {
          assertCurrent();
          await refreshStoredRootProof(
            tomb,
            owner.root[0],
            owner.root[1],
            assertCurrent,
          );
          assertCurrent();
          if (owner.current() !== prefs) return;
          const stored: Partial<VaultPrefs> = overlapCast(
            await readPrefsJson(tomb).catch(() => {
              assertCurrent();
              return {};
            }),
          );
          assertCurrent();
          if (owner.current() === prefs)
            owner.restore(normalizeVaultPrefs(stored));
        }
      })
      .catch(() => undefined),
  );
}
