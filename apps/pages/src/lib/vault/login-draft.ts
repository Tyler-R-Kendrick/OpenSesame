import type { Folder, LoginItem, VaultItem } from "./model.js";
import { newUri } from "./model.js";

export type LoginDraftView = {
  name: string;
  username: string;
  url: string | null;
  websites: string[];
  folderId: string | null;
  folderName: string | null;
  favorite: boolean;
  folders: { id: string; name: string }[];
};

export type LoginDraftPatch = {
  name?: string;
  username?: string;
  url?: string;
  folderId?: string | null;
  favorite?: boolean;
};

export type LoginDraftPort = {
  read: () => LoginDraftView;
  patch: (changes: LoginDraftPatch) => LoginDraftView;
};

let port: LoginDraftPort | null = null;

export function bindLoginDraft(next: LoginDraftPort): () => void {
  port = next;
  return () => {
    if (port === next) port = null;
  };
}

export function requireLoginDraft(): LoginDraftPort {
  if (!port) throw new Error("login_form_unavailable");
  return port;
}

export function loginDraftView(
  draft: VaultItem,
  folders: Folder[],
): LoginDraftView {
  if (draft.kind !== "login") throw new Error("not_a_login_draft");
  const folder = folders.find((entry) => entry.id === draft.folderId);
  return {
    name: draft.name,
    username: draft.username,
    url: draft.uris[0]?.uri || null,
    websites: draft.uris.map((entry) => entry.uri).filter(Boolean),
    folderId: draft.folderId,
    folderName: folder?.name ?? null,
    favorite: draft.favorite,
    folders: folders.map((entry) => ({ id: entry.id, name: entry.name })),
  };
}

export function applyLoginDraftPatch(
  draft: VaultItem,
  changes: LoginDraftPatch,
): LoginItem {
  if (draft.kind !== "login") throw new Error("not_a_login_draft");
  let next: LoginItem = draft;
  if (changes.name !== undefined) next = { ...next, name: changes.name };
  if (changes.username !== undefined)
    next = { ...next, username: changes.username };
  if (changes.folderId !== undefined)
    next = { ...next, folderId: changes.folderId };
  if (changes.favorite !== undefined)
    next = { ...next, favorite: changes.favorite };
  if (changes.url !== undefined) {
    const [first = newUri(), ...rest] = draft.uris;
    next = {
      ...next,
      uris: [{ ...first, uri: changes.url, match: "domain" }, ...rest],
    };
  }
  return next;
}
