import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import { vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";

/** Presentation-only writer substitution retains the real store lifetime check. */
export function editorPresentationWriter(
  saveItem: (item: VaultItem) => Promise<void>,
) {
  return { saveItem, pinContinuation: vaultStore.pinContinuation };
}

type PresentationVault = { current: { items: VaultItem[]; folders: Folder[] } };

/** Install only the legacy presentation and write-I/O substitutions. */
export function installEditorPresentation(
  vault: PresentationVault,
  saveItem: (item: VaultItem) => Promise<void>,
) {
  const original = { ...vaultHooksSeams };
  Object.assign(vaultHooksSeams, {
    useVault: () => vault.current,
    useVaultStore: () => editorPresentationWriter(saveItem),
    useCopySecret: () => vi.fn().mockResolvedValue("copied"),
  });
  return () => Object.assign(vaultHooksSeams, original);
}
