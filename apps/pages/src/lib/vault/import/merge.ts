/**
 * Turning a reviewed preview into vault items.
 *
 * Kept pure and separate from the store so the confirm step can be planned,
 * counted, and shown before anything is sealed to disk.
 */

import {
  type CustomField,
  type Folder,
  type LoginUri,
  type VaultItem,
  newId,
} from "../model.js";
import { duplicateKey } from "./index.js";
import type { DraftItem } from "./types.js";

export type MergeOptions = {
  /**
   * When set, every imported item lands here regardless of its source folder,
   * and the source folder is preserved as a field. Keeps a first import from
   * scattering dozens of folders through a tidy vault.
   */
  intoFolder: string | null;
  /** Recreate the folders named by the export. Ignored when `intoFolder` is set. */
  keepFolders: boolean;
  /** Drop an incoming item when the vault already has that kind, name, and username. */
  skipDuplicates: boolean;
};

export type MergePlan = {
  /** Items to append. */
  items: VaultItem[];
  /** Folders to append — only the ones that did not already exist. */
  newFolders: Folder[];
  duplicates: DraftItem[];
};

export const defaultMergeOptions: MergeOptions = {
  intoFolder: null,
  keepFolders: true,
  skipDuplicates: true,
};

export function planMerge(
  drafts: DraftItem[],
  existingItems: VaultItem[],
  existingFolders: Folder[],
  options: MergeOptions,
): MergePlan {
  const now = new Date().toISOString();

  const seen = new Set(
    existingItems
      .filter((item) => item.deletedAt === null)
      .map((item) =>
        duplicateKey({
          kind: item.kind,
          name: item.name,
          username: "username" in item ? item.username : "",
        }),
      ),
  );

  const byName = new Map<string, Folder>();
  for (const folder of existingFolders) {
    byName.set(folder.name.trim().toLowerCase(), folder);
  }
  const newFolders: Folder[] = [];

  const folderIdFor = (name: string | null): string | null => {
    const trimmed = name?.trim() ?? "";
    if (trimmed === "") return null;
    const key = trimmed.toLowerCase();
    const found = byName.get(key);
    if (found) return found.id;
    const folder: Folder = { id: newId(), name: trimmed, createdAt: now };
    byName.set(key, folder);
    newFolders.push(folder);
    return folder.id;
  };

  const destination = options.intoFolder
    ? folderIdFor(options.intoFolder)
    : null;

  const items: VaultItem[] = [];
  const duplicates: DraftItem[] = [];

  for (const draft of drafts) {
    const key = duplicateKey({
      kind: draft.kind,
      name: draft.name,
      username: draft.kind === "login" ? draft.username : "",
    });
    if (seen.has(key)) {
      duplicates.push(draft);
      if (options.skipDuplicates) continue;
    }
    seen.add(key);

    const fields: CustomField[] = draft.fields.map((field) => ({
      id: newId(),
      name: field.name,
      value: field.value,
      hidden: field.hidden,
    }));

    // With everything funnelled into one folder, the source grouping would be
    // lost outright, so it is kept as a field rather than dropped.
    if (destination !== null && draft.folder) {
      fields.push({
        id: newId(),
        name: "Imported from folder",
        value: draft.folder,
        hidden: false,
      });
    }

    const folderId =
      destination !== null
        ? destination
        : options.keepFolders
          ? folderIdFor(draft.folder)
          : null;

    const base = {
      id: newId(),
      name: draft.name || "Untitled",
      folderId,
      favorite: draft.favorite,
      notes: draft.notes,
      fields,
      createdAt: draft.createdAt ?? now,
      updatedAt: draft.updatedAt ?? now,
      deletedAt: null,
    };

    switch (draft.kind) {
      case "login": {
        const uris: LoginUri[] = draft.uris.map((uri) => ({
          id: newId(),
          uri: uri.uri,
          match: uri.match,
        }));
        items.push({
          ...base,
          kind: "login",
          username: draft.username,
          password: draft.password,
          totp: draft.totp,
          uris,
          // Health scoring reads this. Without a real date from the export,
          // the import date is the only claim we can honestly make.
          passwordChangedAt:
            draft.passwordChangedAt ??
            draft.updatedAt ??
            draft.createdAt ??
            now,
        });
        break;
      }
      case "card":
        items.push({
          ...base,
          kind: "card",
          cardholder: draft.cardholder,
          brand: draft.brand,
          number: draft.number,
          expMonth: draft.expMonth,
          expYear: draft.expYear,
          code: draft.code,
        });
        break;
      case "note":
        items.push({ ...base, kind: "note" });
        break;
    }
  }

  return { items, newFolders, duplicates };
}
