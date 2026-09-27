/**
 * Sample data's view-model (DESIGN.md: "badge sample data on every item and
 * keep removing it to one action"). Never seeded: a person asks for it from
 * Settings › Vaults, every item it writes carries `sample: true` (the tree
 * and the detail pane badge it), and one key takes every one of them out
 * again. Pure over a store port, so any shell drives the same two writes.
 */
import type { Folder, VaultItem } from "@opensesame/vault-core";
import {
  SAMPLE_FOLDER_NAME,
  buildSample,
  sampleFolder,
} from "../../lib/vault/sample.js";

/** The one key the panel draws: load when there is none, remove when there is. */
export type SampleKey = Readonly<{
  action: "load" | "remove";
  /** Sample items in the vault, live or in the trash. */
  count: number;
  /** The key's accessible name and tooltip. */
  label: string;
}>;

/** The one write a load makes: badged items, and a folder when it needs one. */
export type SampleLoad = { items: VaultItem[]; newFolders: Folder[] };

/** What loading and removing ask of the vault store. */
export type SampleStorePort = Readonly<{
  applyImport: (plan: SampleLoad) => Promise<number>;
  removeSample: () => Promise<void>;
}>;

export function sampleCount(items: readonly VaultItem[]): number {
  return items.filter((item) => item.sample === true).length;
}

export function sampleKey(items: readonly VaultItem[]): SampleKey {
  const count = sampleCount(items);
  if (count === 0) {
    return { action: "load", count, label: "Load sample data" };
  }
  return {
    action: "remove",
    count,
    label: `Remove ${count} sample ${count === 1 ? "item" : "items"}`,
  };
}

/**
 * The items and the folder a load writes. A `Sample data` folder already in
 * the vault is reused rather than doubled; otherwise a new one is made.
 */
export function planSampleLoad(folders: readonly Folder[]): SampleLoad {
  const existing = folders.find((folder) => folder.name === SAMPLE_FOLDER_NAME);
  const folder = existing ?? sampleFolder();
  return {
    items: buildSample(folder.id),
    newFolders: existing ? [] : [folder],
  };
}

/**
 * Press the key: load writes the sample set in one mutation; remove takes
 * out every `sample` item and a folder only they sat in, and nothing else.
 */
export async function pressSampleKey(
  key: SampleKey,
  folders: readonly Folder[],
  store: SampleStorePort,
): Promise<void> {
  if (key.action === "remove") {
    await store.removeSample();
    return;
  }
  await store.applyImport(planSampleLoad(folders));
}
