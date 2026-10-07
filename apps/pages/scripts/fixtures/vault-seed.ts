import "./install-browser-host.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";

/**
 * Disposable browser-context fixture: seals a vault under a master password
 * through the store, the one road left to one now that no screen makes it
 * (ADR 0180). For walks that need a wrap that travels to a second device — a
 * PIN never does. This entry is never part of the Pages build.
 */
export async function seed(password: string): Promise<void> {
  await vaultStore.create(password);
  vaultStore.lock();
}
