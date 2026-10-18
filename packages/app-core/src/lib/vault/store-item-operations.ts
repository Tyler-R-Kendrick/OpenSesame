/** Body-only operations; all mutations run through the Store's captured write admission. */
import type { Folder, VaultBody, VaultItem } from "@opensesame/vault-core";
import {
  appendItems,
  deleteFolder,
  renameFolder,
  replaceItems,
  restoreItem,
  toggleFavorite,
} from "./body-edits.js";
import {
  type EnvironmentsEdit,
  applyEnvironmentsEdit,
} from "./body-environments.js";
import { commitDiscard, revokeTrashedShares } from "./drop-revoke.js";
import {
  type ItemReturn,
  type ItemWithdrawal,
  restoreIntoBody,
  withdrawFromBody,
} from "./item-departure.js";
import {
  type ItemImportPlan,
  type ItemWriteHost,
  type ManifestWritePlan,
  writeManifestItems,
  writeSavedItems,
} from "./item-writes.js";
import {
  installDefinition,
  newVaultFolder,
  uninstallDefinition,
} from "./store-item-types.js";
type ItemOperationsHost = Readonly<{
  body: () => VaultBody;
  items: () => VaultItem[];
  mutate: (change: (body: VaultBody) => void) => Promise<void>;
  writes: (check?: () => void) => ItemWriteHost;
}>;
function edits(host: ItemOperationsHost) {
  return {
    restoreItem: (id: string) => host.mutate((body) => restoreItem(body, id)),
    withdrawItems: (plan: ItemWithdrawal) =>
      host.mutate((body) => withdrawFromBody(body, plan)),
    restoreWithdrawn: (back: ItemReturn) =>
      host.mutate((body) => restoreIntoBody(body, back)),
    toggleFavorite: (id: string) =>
      host.mutate((body) => toggleFavorite(body, id)),
    editEnvironments: (edit: EnvironmentsEdit) =>
      host.mutate((body) => applyEnvironmentsEdit(body, edit)),
    replaceAll: (items: VaultItem[], folders: Folder[]) =>
      host.mutate((body) => replaceItems(body, items, folders)),
    addItems: (items: VaultItem[]) =>
      host.mutate((body) => appendItems(body, items, [])),
    renameFolder: (id: string, name: string) =>
      host.mutate((body) => renameFolder(body, id, name)),
    deleteFolder: (id: string) => host.mutate((body) => deleteFolder(body, id)),
    async addFolder(name: string) {
      const folder = newVaultFolder(name);
      await host.mutate((body) => {
        body.folders = [...body.folders, folder];
      });
      return folder;
    },
  };
}
function writes(host: ItemOperationsHost) {
  const discard = (kind: "trash" | "purge" | "empty", id: string) =>
    commitDiscard(kind, host.items(), id, host.mutate);
  return {
    saveItem: (item: VaultItem, folder?: Folder) =>
      writeSavedItems(host.writes(), [item], folder),
    saveItems: (
      items: readonly VaultItem[],
      folder?: Folder,
      check?: () => void,
    ) => writeSavedItems(host.writes(check), items, folder),
    trashItem: (id: string) => discard("trash", id),
    purgeItem: (id: string) => discard("purge", id),
    emptyTrash: () => discard("empty", ""),
    reconcileTrashedShares: () =>
      revokeTrashedShares(host.items(), host.mutate),
    applyManifestMerge: (plan: ManifestWritePlan) =>
      writeManifestItems(host.writes(), plan),
    async applyImport(plan: ItemImportPlan) {
      if (!plan.items.length && !plan.newFolders.length) return 0;
      await host.mutate((body) =>
        appendItems(body, plan.items, plan.newFolders),
      );
      return plan.items.length;
    },
  };
}
export function createStoreItemOperations(host: ItemOperationsHost) {
  return {
    ...edits(host),
    ...writes(host),
    installItemTypeDefinition: (text: string) =>
      installDefinition(text, host.mutate, host.body),
    uninstallItemTypeDefinition: (id: string) =>
      uninstallDefinition(id, host.mutate, host.body),
  };
}
