import { retiredCredentialOwnerSeams } from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { defaultStateDir } from "@opensesame/app-core/node/host.js";
import { useVaultKv } from "./vault-kv.js";

/** A fresh local human command uses the same credential classifier as the PWA. */
export async function openLocalVault(
  stateDir = defaultStateDir(),
): Promise<VaultStore> {
  await useVaultKv(stateDir);
  const { vaultStore } = await import(
    "@opensesame/app-core/lib/vault/store.js"
  );
  vaultStore.lock();
  vaultStore.rehydrate();
  retiredCredentialOwnerSeams.isRealOwner = (tomb) => {
    const state = vaultStore.getSnapshot();
    return (
      state.status === "unlocked" &&
      state.tomb === tomb &&
      !state.guest &&
      !state.decoy &&
      !state.awaitingSecondStep
    );
  };
  return vaultStore;
}

export function unlockLocalVault(
  store: VaultStore,
  password: string,
): Promise<string> {
  return unlockWithRetiredCredentialGate(store, password);
}
