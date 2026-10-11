/**
 * What a recovering circle protects (ADR 0187 §5): the vault's items, or one
 * folder's, written by the vault's own CXF export and sealed under the
 * circle's recovery secret. Recovery hands the same document back to the
 * normal import; this file never writes an item of its own.
 *
 * A CXF document is plaintext. It is built at the moment a circle is made,
 * handed straight to the desk, and held nowhere else. The circle's own
 * records are left out of it: an owner key or a wrapped share has no business
 * inside a file a recipient opens.
 */

import type { Json } from "@opensesame/app-core/lib/quorum/canonical.js";
import { DeskError } from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  GUARDIAN_SHARE_TYPE,
  TRUSTED_CIRCLE_TYPE,
} from "@opensesame/app-core/lib/quorum/records.js";
import { buildCxfExport } from "@opensesame/app-core/lib/vault/export/cxf.js";
import { folderQuery } from "@opensesame/app-core/lib/vault/path-suggest.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store.js";
import type { Folder, VaultItem } from "@opensesame/vault-core";
import type { Scope } from "./circle-model.js";

/** The slice of the open vault a payload is read from. */
export type PayloadSource = Pick<VaultState, "items" | "folders">;

export type Payload = Readonly<{
  /** The CXF document, as the plain JSON the circle seals. */
  document: Json;
  /** Items the export could not carry. */
  skipped: number;
  /** Passwords the export held back because they are not whole. */
  withheld: number;
}>;

function isCircleRecord(item: VaultItem): boolean {
  return (
    item.kind === "typed" &&
    (item.typeId === TRUSTED_CIRCLE_TYPE || item.typeId === GUARDIAN_SHARE_TYPE)
  );
}

/** The folders a path names: that folder and everything under it. */
export function foldersUnder(
  folders: readonly Folder[],
  path: string,
): Folder[] {
  const wanted = folderQuery(path).toLowerCase();
  if (wanted === "") return [];
  return folders.filter((folder) => {
    const name = folder.name.toLowerCase();
    return name === wanted || name.startsWith(`${wanted}/`);
  });
}

/** The folder a path names, as the vault spells it. */
export function folderNamed(
  folders: readonly Folder[],
  path: string,
): Folder | undefined {
  const wanted = folderQuery(path).toLowerCase();
  return folders.find((folder) => folder.name.toLowerCase() === wanted);
}

type Chosen = Readonly<{ items: VaultItem[]; folders: Folder[] }>;

function inScope(vault: PayloadSource, scope: Scope): Chosen {
  const live = vault.items.filter((item) => !isCircleRecord(item));
  if (scope.protects !== "folder") {
    return { items: live, folders: [...vault.folders] };
  }
  const folders = foldersUnder(vault.folders, scope.folder);
  if (folders.length === 0) {
    throw new DeskError("folder", "that folder is not in this vault");
  }
  const ids = new Set(folders.map((folder) => folder.id));
  return {
    items: live.filter(
      (item) => item.folderId !== null && ids.has(item.folderId),
    ),
    folders,
  };
}

/** The document a recovering circle protects, from the open vault. */
export function circlePayload(vault: PayloadSource, scope: Scope): Payload {
  const chosen = inScope(vault, scope);
  const result = buildCxfExport(
    { v: 1, items: chosen.items, folders: chosen.folders },
    { humanConfirmed: true },
  );
  const [account] = result.document.accounts;
  if (!account || account.items.length === 0) {
    throw new DeskError("payload_empty", "there is nothing here to protect");
  }
  return {
    // The document is plain data; the round trip is the boundary the desk takes.
    document: JSON.parse(JSON.stringify(result.document)),
    skipped: result.skipped.length,
    withheld: result.withheld,
  };
}
