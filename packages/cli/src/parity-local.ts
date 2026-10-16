/**
 * The local half of secret-reference resolution: an `os://vault/item/field`
 * reference is read from this device's OpenSesame vault, unlocked on the
 * controlling terminal the way `vault` commands unlock it. Resolution is
 * read-only and the unlocked store is shared for the life of the process,
 * so a run with several references prompts once.
 */
import { configureHost } from "@opensesame/app-core/host.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  createNodeHost,
  defaultStateDir,
} from "@opensesame/app-core/node/host.js";
import { readPasswordFromTty } from "./tty-password.js";
import { useVaultKv } from "./vault-kv.js";

let unlockedStore: Promise<VaultStore> | undefined;

async function openUnlockedStore(): Promise<VaultStore> {
  const stateDir = defaultStateDir();
  await useVaultKv(stateDir);
  configureHost(createNodeHost({ stateDir }));
  const { vaultStore } = await import(
    "@opensesame/app-core/lib/vault/store.js"
  );
  vaultStore.lock();
  vaultStore.rehydrate();
  const snapshot = vaultStore.getSnapshot();
  if (snapshot.status === "empty")
    throw new Error(
      "There is no local vault yet. Create an item with vault new.",
    );
  if (snapshot.status !== "unlocked" || snapshot.awaitingSecondStep) {
    await vaultStore.unlock(await readPasswordFromTty("Master password: "));
  }
  return vaultStore;
}

/** Resolve one os:// reference against the unlocked local vault. */
export async function readLocalReference(reference: string): Promise<string> {
  unlockedStore ??= openUnlockedStore();
  try {
    await unlockedStore;
  } catch (error) {
    unlockedStore = undefined;
    throw error;
  }
  const { resolveLocalReference } = await import(
    "@opensesame/app-core/lib/vault/password-workflows.js"
  );
  return resolveLocalReference(reference);
}
