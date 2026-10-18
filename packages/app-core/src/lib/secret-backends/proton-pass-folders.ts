import { z } from "zod";
import {
  type ProtonCryptoOwner,
  importProtonKey,
  openProtonValue,
} from "./proton-pass-crypto.js";
import type { ProtonPassAccess } from "./proton-pass-session.js";
import { SecretBackendError } from "./types.js";

const Text = z.string().min(1).max(4096);
const Folder = z.object({
  VaultID: Text,
  FolderID: Text,
  ParentFolderID: Text.nullable(),
  KeyRotation: z.number().int().min(0).max(255),
  FolderKey: z.string().min(80).max(80),
  ContentFormatVersion: z.literal(1),
  Content: z.string().min(40).max(1400000),
});
const Page = z.object({
  Code: z.literal(1000),
  Folders: z.object({
    Folders: z.array(Folder).max(100),
    LastToken: Text.nullish(),
  }),
});
export type ProtonFolderRevision = z.infer<typeof Folder>;

function invalid(): never {
  throw new SecretBackendError(
    "response",
    "Proton Pass returned an invalid or incomplete encrypted folder chain.",
  );
}
function current(owner: ProtonCryptoOwner): void {
  owner.assertCurrent();
  if (owner.signal.aborted)
    throw new SecretBackendError(
      "stale",
      "The Proton Pass folder operation ended.",
    );
}
async function folderRevisions(
  access: ProtonPassAccess,
  owner: ProtonCryptoOwner,
): Promise<Map<string, ProtonFolderRevision>> {
  const folders = new Map<string, ProtonFolderRevision>();
  const cursors = new Set<string>();
  let since: string | null = null;
  let characters = 0;
  for (let page = 0; page < 100; page += 1) {
    current(owner);
    const query = new URLSearchParams({ PageSize: "100" });
    if (since !== null) query.set("Since", since);
    const parsed = Page.safeParse(await access.request(`folder?${query}`));
    current(owner);
    if (!parsed.success) invalid();
    for (const folder of parsed.data.Folders.Folders) {
      if (
        folder.VaultID !== access.share.vaultId ||
        folders.has(folder.FolderID)
      )
        invalid();
      characters +=
        folder.Content.length +
        folder.FolderKey.length +
        folder.FolderID.length +
        folder.VaultID.length +
        (folder.ParentFolderID?.length ?? 0);
      if (characters > 32 * 1024 * 1024) invalid();
      folders.set(folder.FolderID, folder);
    }
    const next = parsed.data.Folders.LastToken;
    if (!next) return folders;
    if (cursors.has(next) || parsed.data.Folders.Folders.length === 0)
      invalid();
    cursors.add(next);
    since = next;
  }
  invalid();
}
function pathTo(
  id: string,
  folders: ReadonlyMap<string, ProtonFolderRevision>,
): ProtonFolderRevision[] {
  const path: ProtonFolderRevision[] = [];
  const seen = new Set<string>();
  let currentId: string | null = id;
  while (currentId !== null) {
    if (path.length >= 64 || seen.has(currentId)) invalid();
    seen.add(currentId);
    const folder = folders.get(currentId);
    if (!folder) invalid();
    path.push(folder);
    currentId = folder.ParentFolderID;
  }
  return path.reverse();
}

/** One operation-local snapshot; every use checks its exact captured owner. */
export function createProtonFolderKeys(
  access: ProtonPassAccess,
  owner: ProtonCryptoOwner,
): (id: string) => Promise<CryptoKey> {
  let snapshot: Promise<Map<string, ProtonFolderRevision>> | undefined;
  const keys = new Map<string, CryptoKey>();
  return async (id) => {
    current(owner);
    snapshot ??= folderRevisions(access, owner);
    const folders = await snapshot;
    current(owner);
    const path = pathTo(id, folders);
    let parent: CryptoKey | undefined;
    for (const folder of path) {
      current(owner);
      const cached = keys.get(folder.FolderID);
      if (cached) {
        parent = cached;
        continue;
      }
      const wrapping = parent ?? access.key(folder.KeyRotation);
      const raw = await openProtonValue(
        folder.FolderKey,
        wrapping,
        "folderkey",
        owner,
      );
      try {
        parent = await importProtonKey(raw, owner);
        current(owner);
        keys.set(folder.FolderID, parent);
      } finally {
        raw.fill(0);
      }
    }
    current(owner);
    if (!parent) invalid();
    return parent;
  };
}
