/** Existing installed-type persistence, retaining registry rollback on write failure. */
import {
  type InstallResult,
  type VaultBody,
  installItemType,
  installedDefinitions,
  syncInstalledTypes,
  uninstallItemType,
} from "@opensesame/vault-core";
import { recordItemTypes } from "./body-edits.js";

type Mutate = (change: (body: VaultBody) => void) => Promise<void>;
export async function installDefinition(
  text: string,
  mutate: Mutate,
  body: () => VaultBody,
): Promise<InstallResult> {
  const result = installItemType(text);
  if (!result.ok) return result;
  const added = [result.definition.metadata.id];
  try {
    await mutate((draft) =>
      recordItemTypes(draft, installedDefinitions(), { added }),
    );
  } catch (error) {
    syncInstalledTypes(body().itemTypes);
    throw error;
  }
  return result;
}

export async function uninstallDefinition(
  id: string,
  mutate: Mutate,
  body: () => VaultBody,
): Promise<boolean> {
  if (!uninstallItemType(id)) return false;
  try {
    await mutate((draft) =>
      recordItemTypes(draft, installedDefinitions(), { removed: [id] }),
    );
  } catch (error) {
    syncInstalledTypes(body().itemTypes);
    throw error;
  }
  return true;
}
