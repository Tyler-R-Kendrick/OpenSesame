import { SecretBackendHttpError } from "./http.js";
import {
  type ProtonCryptoOwner,
  importProtonKey,
  openProtonValue,
  sealProtonValue,
} from "./proton-pass-crypto.js";
import { createProtonFolderKeys } from "./proton-pass-folders.js";
import {
  createProtonItem,
  decodeProtonItem,
  updateProtonItem,
} from "./proton-pass-item-codec.js";
import {
  type ProtonItemRevision,
  activeProtonItem,
  canBeProtonItemId,
  protonItemId,
  protonItemReply,
  protonItemRevisions,
  protonSuccess,
} from "./proton-pass-items.js";
import {
  type ProtonPassAccess,
  createProtonPassSessions,
} from "./proton-pass-session.js";
import type { SecretBackendTransport } from "./transport.js";
import {
  type SecretBackend,
  type SecretBackendConfiguration,
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
  type SecretBackendSession,
} from "./types.js";

type ProtonMutation =
  | {
      KeyRotation: number;
      ContentFormatVersion: 7;
      Content: string;
      ItemKey: string;
    }
  | {
      KeyRotation: number;
      LastRevision: number;
      ContentFormatVersion: 7;
      Content: string;
    }
  | { Items: { ItemID: string; Revision: number }[] };

type Context = {
  access: ProtonPassAccess;
  owner: ProtonCryptoOwner;
  folderKey: (id: string) => Promise<CryptoKey>;
};
export interface ProtonPassBackend extends SecretBackend {
  authenticate(
    config: Pick<
      SecretBackendConfiguration,
      "baseUrl" | "token" | "vaultId" | "appVersion"
    >,
  ): Promise<SecretBackendSession>;
  createItem(
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ): Promise<SecretBackendItem>;
  updateItem(
    id: string,
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ): Promise<SecretBackendItem>;
  deleteItem(id: string, session: SecretBackendSession): Promise<void>;
}
async function itemKey(
  item: ProtonItemRevision,
  held: Context,
): Promise<CryptoKey> {
  activeProtonItem(item);
  const wrapping = item.FolderID
    ? await held.folderKey(item.FolderID)
    : held.access.key(item.KeyRotation);
  const raw = await openProtonValue(
    item.ItemKey,
    wrapping,
    "itemkey",
    held.owner,
  );
  try {
    return await importProtonKey(raw, held.owner);
  } finally {
    raw.fill(0);
  }
}
async function plainItem(
  item: ProtonItemRevision,
  held: Context,
  key: CryptoKey,
): Promise<Uint8Array> {
  return openProtonValue(item.Content, key, "itemcontent", held.owner);
}
async function project(
  item: ProtonItemRevision,
  held: Context,
): Promise<SecretBackendItem> {
  const key = await itemKey(item, held);
  const bytes = await plainItem(item, held, key);
  try {
    const projection = decodeProtonItem(bytes);
    held.owner.assertCurrent();
    return { id: item.ItemID, ...projection };
  } finally {
    bytes.fill(0);
  }
}
async function supportedItem(
  item: ProtonItemRevision,
  held: Context,
): Promise<SecretBackendItem | null> {
  try {
    return await project(item, held);
  } catch (error) {
    if (error instanceof SecretBackendError && error.code === "unsupported")
      return null;
    throw error;
  }
}
function writable(held: Context): void {
  held.owner.assertCurrent();
  if (!held.access.share.writable)
    throw new SecretBackendError(
      "authentication",
      "An editor PAT grant is required to write items.",
    );
}
function json(body: ProtonMutation, method: "POST" | "PUT"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
async function revision(
  id: string,
  held: Context,
): Promise<ProtonItemRevision> {
  try {
    const item = protonItemReply(
      await held.access.request(`item/${protonItemId(id)}`),
    );
    if (item.ItemID !== id)
      throw new SecretBackendError(
        "response",
        "Proton Pass returned a different item.",
      );
    activeProtonItem(item);
    return item;
  } catch (error) {
    if (error instanceof SecretBackendHttpError && error.status === 404)
      throw new SecretBackendError(
        "not-found",
        "The Proton Pass item was not found.",
      );
    throw error;
  }
}
async function mutate(
  held: Context,
  path: string,
  init: RequestInit,
): Promise<void> {
  try {
    protonSuccess(await held.access.request(path, init));
  } catch (error) {
    if (error instanceof SecretBackendHttpError && error.status === 409)
      throw new SecretBackendError(
        "stale",
        "The Proton Pass item changed. Reload before trying again.",
      );
    throw error;
  }
}

async function find(name: string, held: Context): Promise<SecretBackendItem> {
  if (canBeProtonItemId(name)) {
    try {
      return await project(await revision(name, held), held);
    } catch (error) {
      if (!(error instanceof SecretBackendError) || error.code !== "not-found")
        throw error;
    }
  }
  const items = await protonItemRevisions(held.access);
  const matches: SecretBackendItem[] = [];
  for (const item of items) {
    if (item.State !== 1) continue;
    const opened = await supportedItem(item, held);
    if (!opened) continue;
    if (opened.id === name) return opened;
    if (opened.name === name) matches.push(opened);
  }
  if (matches.length > 1)
    throw new SecretBackendError(
      "ambiguous",
      "Multiple Proton Pass items have that name. Select its item ID.",
    );
  const match = matches[0];
  if (!match)
    throw new SecretBackendError(
      "not-found",
      "The Proton Pass item was not found.",
    );
  return match;
}

async function list(held: Context) {
  const items = await protonItemRevisions(held.access);
  const result = [];
  for (const item of items) {
    if (item.State !== 1) continue;
    const opened = await supportedItem(item, held);
    if (!opened) continue;
    result.push({ id: opened.id, name: opened.name, kind: opened.kind });
  }
  held.owner.assertCurrent();
  return result;
}

async function create(
  input: SecretBackendItemInput,
  held: Context,
): Promise<SecretBackendItem> {
  writable(held);
  const bytes = createProtonItem(input);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    const key = await importProtonKey(raw, held.owner);
    const wrapped = await sealProtonValue(
      raw,
      held.access.key(held.access.latestRotation),
      "itemkey",
      held.owner,
    );
    const content = await sealProtonValue(
      bytes,
      key,
      "itemcontent",
      held.owner,
    );
    const created = protonItemReply(
      await held.access.request(
        "item",
        json(
          {
            KeyRotation: held.access.latestRotation,
            ContentFormatVersion: 7,
            Content: content,
            ItemKey: wrapped,
          },
          "POST",
        ),
      ),
    );
    protonItemId(created.ItemID);
    if (
      created.KeyRotation !== held.access.latestRotation ||
      created.ItemKey !== wrapped ||
      created.Content !== content
    )
      throw new SecretBackendError(
        "response",
        "Proton Pass returned an item different from the encrypted create request.",
      );
    return await project(created, held);
  } finally {
    bytes.fill(0);
    raw.fill(0);
  }
}
async function update(
  id: string,
  input: SecretBackendItemInput,
  held: Context,
): Promise<SecretBackendItem> {
  writable(held);
  const item = await revision(id, held);
  const key = await itemKey(item, held);
  const original = await plainItem(item, held, key);
  let edited: Uint8Array | undefined;
  try {
    edited = updateProtonItem(original, input);
    const content = await sealProtonValue(
      edited,
      key,
      "itemcontent",
      held.owner,
    );
    await mutate(
      held,
      `item/${protonItemId(id)}`,
      json(
        {
          KeyRotation: item.KeyRotation,
          LastRevision: item.Revision,
          ContentFormatVersion: 7,
          Content: content,
        },
        "PUT",
      ),
    );
    return await project(await revision(id, held), held);
  } finally {
    original.fill(0);
    edited?.fill(0);
  }
}

/** Native encrypted provider port; public appVersion is explicit, never a credential/client-ID fallback. */
export function createProtonPassBackend(
  transport: SecretBackendTransport,
  appVersion = "",
): ProtonPassBackend {
  const sessions = createProtonPassSessions(transport);
  const context = (session: SecretBackendSession): Context => {
    const access = sessions.read(session);
    if (!session.signal)
      throw new SecretBackendError(
        "stale",
        "The Proton Pass session has no active owner.",
      );
    const owner: ProtonCryptoOwner = {
      signal: AbortSignal.any([transport.signal, session.signal]),
      assertCurrent() {
        transport.assertCurrent();
        sessions.read(session);
        access.key(access.latestRotation);
      },
    };
    return { access, owner, folderKey: createProtonFolderKeys(access, owner) };
  };
  return {
    id: "proton-pass",
    name: "Proton Pass",
    signal: transport.signal,
    capabilities: {
      itemKinds: ["note", "login"],
      itemFields: ["notes", "secret", "username", "url"],
      vaultBackup: { kind: "note", field: "notes", maxBytes: 768 * 1024 },
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
      import: false,
    },
    authenticate(config) {
      return sessions.authenticate({
        baseUrl: config.baseUrl,
        token: config.token,
        vaultId: config.vaultId,
        appVersion: config.appVersion ?? appVersion,
      });
    },
    disconnect: sessions.disconnect,
    async getItem(name, session) {
      return find(name, context(session));
    },
    async getNotes(name, session) {
      return (await find(name, context(session))).notes;
    },
    async listItems(session) {
      return list(context(session));
    },
    async createItem(input, session) {
      return create(input, context(session));
    },
    async updateItem(id, input, session) {
      return update(id, input, context(session));
    },
    async deleteItem(id, session) {
      const held = context(session);
      writable(held);
      const item = await revision(id, held);
      // The common remove operation uses Proton's reversible trash protocol.
      await mutate(
        held,
        "item/trash",
        json({ Items: [{ ItemID: id, Revision: item.Revision }] }, "POST"),
      );
    },
  };
}
