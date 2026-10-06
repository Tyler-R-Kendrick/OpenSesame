/**
 * Which virtual files each Settings category has beyond its own document
 * (`settings/<category>/config.yaml`). Vaults carries the item types and
 * Capabilities its capability documents; a
 * category a capability contributes brings its own provider with it
 * (Notifications, `notifications.routing`); the other categories are one
 * document each.
 */
import { defaultCapabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-resources.js";
import { tombUnlocked } from "@opensesame/app-core/lib/vfs.js";
import { capabilityFiles } from "@opensesame/app-core/sections/settings/capability-files.js";
import { itemTypeFiles } from "@opensesame/app-core/sections/settings/item-type-files.js";
import { securityFiles } from "@opensesame/app-core/sections/settings/security-files.js";
import {
  type VirtualFileProvider,
  mergeFileProviders,
  withoutConcealedFiles,
} from "@opensesame/app-core/sections/settings/virtual-files.js";
import { useMemo, useRef } from "react";
import { useContributions } from "../../../bindings/contributions.js";
import { useVault, useVaultStore } from "../../../lib/vault/hooks.js";
import { useDuressPanelShown } from "../security/DuressPanel.js";
import { useDeviceOperator } from "../useDeviceOperator.js";
import {
  notifySettingsFilesChanged,
  useSettingsFilesRevision,
} from "./revision.js";

type Store = ReturnType<typeof useVaultStore>;

function openTomb(store: Store): string | null {
  const tomb = store.activeTomb();
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

/**
 * The files the panels a capability draws inside `category` bring — a
 * Capabilities section's plugin panel (`capabilities.feature-<id>`) lists
 * its file under Capabilities.
 */
function usePanelFiles(category: string): VirtualFileProvider[] {
  return useContributions("settings-panel")
    .filter(
      (entry) =>
        entry.category === category ||
        entry.category.startsWith(`${category}.`),
    )
    .flatMap((entry) => (entry.files ? [entry.files] : []));
}

/**
 * One merged provider per set of members: the editor re-reads when its
 * provider changes, so the same members must give back the same object.
 */
function useMerged(
  members: readonly VirtualFileProvider[],
): VirtualFileProvider | null {
  const last = useRef<{
    members: readonly VirtualFileProvider[];
    merged: VirtualFileProvider | null;
  }>({ members: [], merged: null });
  const same =
    last.current.members.length === members.length &&
    members.every((member, at) => last.current.members[at] === member);
  if (!same) {
    const [only] = members;
    last.current = {
      members,
      // Whatever the members offer, a concealed file is never among it.
      merged:
        members.length === 0
          ? null
          : withoutConcealedFiles(
              members.length === 1 && only ? only : mergeFileProviders(members),
            ),
    };
  }
  return last.current.merged;
}

/**
 * The capability documents, read and written through the S04 adapter. Rebuilt
 * with the open vault and the operator, so a policy is listed to no one else
 * and one vault's files are never written into another's.
 */
export function useCapabilityFiles(): VirtualFileProvider {
  const { tomb } = useVault();
  const operator = useDeviceOperator();
  return useMemo(
    () =>
      capabilityFiles({
        ports: () => defaultCapabilityPorts(() => tomb),
        operator: () => operator,
      }),
    [tomb, operator],
  );
}

/**
 * Travel's safe list and the duress status, for the owner of an open vault —
 * the Duress row's own test, so a guest or a locked device is shown neither.
 * A write redraws the viewer; rebuilt when that test changes.
 */
export function useSecurityFiles(): VirtualFileProvider {
  const shown = useDuressPanelShown();
  const { tomb } = useVault();
  useSettingsFilesRevision();
  return useMemo(() => {
    const provider = securityFiles(
      () => shown,
      () => tomb,
    );
    return {
      ...provider,
      write: async (path, text) => {
        const outcome = await provider.write(path, text);
        if (outcome.ok) notifySettingsFilesChanged();
        return outcome;
      },
    };
  }, [shown, tomb]);
}

export function useCategoryFiles(category: string): VirtualFileProvider | null {
  const itemTypes = useItemTypeFiles();
  const capabilities = useCapabilityFiles();
  const security = useSecurityFiles();
  const contributed = useContributions("settings-category").find(
    (entry) => entry.id === category,
  )?.files;
  const panels = usePanelFiles(category);
  const own =
    category === "vaults"
      ? itemTypes
      : category === "capabilities"
        ? capabilities
        : category === "security" && security.list().length > 0
          ? security
          : (contributed ?? null);
  return useMerged(own === null ? panels : [own, ...panels]);
}
