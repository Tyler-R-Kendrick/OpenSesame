/** Global item definitions change only under the original real store's authority. */
import {
  type InstallResult,
  type VaultBody,
  installItemType,
  installedDefinitions,
  syncInstalledTypes,
  uninstallItemType,
} from "@opensesame/vault-core";
import { assertNotDecoySession } from "../decoy-session.js";
import { recordItemTypes } from "./body-edits.js";
export type ItemTypeHost = {
  assertCurrent(): void;
  mutate(change: (body: VaultBody) => void): Promise<void>;
  definitions(): VaultBody["itemTypes"];
};
export async function installSessionItemType(
  host: ItemTypeHost,
  text: string,
): Promise<InstallResult> {
  host.assertCurrent();
  assertNotDecoySession();
  const result = installItemType(text);
  if (!result.ok) return result;
  try {
    await host.mutate((body) => {
      host.assertCurrent();
      recordItemTypes(body, installedDefinitions(), {
        added: [result.definition.metadata.id],
      });
    });
    host.assertCurrent();
  } catch (error) {
    host.assertCurrent();
    syncInstalledTypes(host.definitions());
    throw error;
  }
  return result;
}
export async function uninstallSessionItemType(
  host: ItemTypeHost,
  id: string,
): Promise<boolean> {
  host.assertCurrent();
  assertNotDecoySession();
  if (!uninstallItemType(id)) return false;
  try {
    await host.mutate((body) => {
      host.assertCurrent();
      recordItemTypes(body, installedDefinitions(), { removed: [id] });
    });
    host.assertCurrent();
  } catch (error) {
    host.assertCurrent();
    syncInstalledTypes(host.definitions());
    throw error;
  }
  return true;
}

/** Capture one operation guard before global definitions or the body can change. */
export function bindSessionItemTypes(
  assertCurrent: () => void,
  mutate: ItemTypeHost["mutate"],
  definitions: ItemTypeHost["definitions"],
): ItemTypeHost {
  return { assertCurrent, mutate, definitions };
}
