/**
 * The account draft a WebMCP agent may see and patch (ADR 0168). The tool and
 * module keep their `login` names: they are the agent-facing contract. The view
 * carries metadata only (name, username, sites, folder, favorite); a password,
 * a pepper, a sealed envelope and an OPRF key have no field here and no path in.
 */
import {
  type AccountItem,
  type Folder,
  type VaultItem,
  newUri,
} from "@opensesame/vault-core";

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
  if (draft.kind !== "account") throw new Error("not_an_account_draft");
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
): AccountItem {
  if (draft.kind !== "account") throw new Error("not_an_account_draft");
  let next: AccountItem = draft;
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
