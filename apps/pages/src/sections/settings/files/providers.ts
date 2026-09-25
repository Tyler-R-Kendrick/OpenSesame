/**
 * Which virtual files each Settings category has beyond its own document
 * (`settings/<category>/config.yaml`). Vaults carries the item types; a
 * category a capability contributes brings its own provider with it
 * (Notifications, `notifications.routing`); the other categories are one
 * document each.
 */
import { tombUnlocked } from "@opensesame/app-core/lib/vfs.js";
import { itemTypeFiles } from "@opensesame/app-core/sections/settings/item-type-files.js";
import type { VirtualFileProvider } from "@opensesame/app-core/sections/settings/virtual-files.js";
import { useMemo } from "react";
import { useContributions } from "../../../bindings/contributions.js";
import { useVault, useVaultStore } from "../../../lib/vault/hooks.js";
import {
  notifySettingsFilesChanged,
  useSettingsFilesRevision,
} from "./revision.js";

type Store = ReturnType<typeof useVaultStore>;

function openTomb(store: Store): string | null {
  const tomb =
    typeof store.activeTomb === "function" ? store.activeTomb() : null;
  return tomb && tombUnlocked(tomb) ? tomb : null;
}

/** The item-type files, stored through this session's vault. */
export function useItemTypeFiles(): VirtualFileProvider {
  const store = useVaultStore();
  // A write to the sealed body redraws through the store; re-reading on every
  // revision keeps a tomb-file write visible to both views as well. The
  // provider is rebuilt when the open vault changes — switching, locking or
  // unlocking — so nothing reads or writes one vault's files into another's.
  const { tomb, status } = useVault();
  useSettingsFilesRevision();
  // biome-ignore lint/correctness/useExhaustiveDependencies: tomb and status name the vault the provider reads, through the store
  return useMemo(() => {
    const provider = itemTypeFiles({
      tomb: () => openTomb(store),
      install: async (text) => {
        const result = await store.installItemTypeDefinition(text);
        return result.ok
          ? { ok: true }
          : { ok: false, message: result.message };
      },
      uninstall: (id) => store.uninstallItemTypeDefinition(id),
    });
    return {
      ...provider,
      write: async (path, text) => {
        const outcome = await provider.write(path, text);
        if (outcome.ok) notifySettingsFilesChanged();
        return outcome;
      },
      remove: async (path) => {
        const outcome = await provider.remove(path);
        if (outcome.ok) notifySettingsFilesChanged();
        return outcome;
      },
    };
  }, [store, tomb, status]);
}

export function useCategoryFiles(category: string): VirtualFileProvider | null {
  const itemTypes = useItemTypeFiles();
  const contributed = useContributions("settings-category").find(
    (entry) => entry.id === category,
  )?.files;
  if (category === "vaults") return itemTypes;
  return contributed ?? null;
}
