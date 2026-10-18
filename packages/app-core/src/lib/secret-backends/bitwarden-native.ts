import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import {
  type BitwardenNativeAccount,
  openBitwardenNativeAccount,
} from "./bitwarden-native-account.js";
import {
  createBitwardenBlobItem,
  readBitwardenBlobItem,
  updateBitwardenBlobItem,
} from "./bitwarden-native-blob-item.js";
import {
  nativeCipherWire,
  nativeItemError,
  nativePersonalCipher,
  nativeText,
} from "./bitwarden-native-item.js";
import type { BitwardenKdfResourceLimits } from "./bitwarden-native-kdf.js";
import {
  createBitwardenLegacyItem,
  readBitwardenLegacyItem,
  updateBitwardenLegacyItem,
} from "./bitwarden-native-legacy-item.js";
import { createSecretBackendSessions } from "./sessions.js";
import {
  type SecretBackendTransport,
  fenceSecretBackend,
} from "./transport.js";
import {
  type SecretBackend,
  type SecretBackendConfiguration,
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
  type SecretBackendSession,
} from "./types.js";

/** These operation inputs become part of the shared native configuration in its activation slice. */
export type BitwardenNativeConfiguration = SecretBackendConfiguration & {
  accountEmail: string;
  masterPassword: string;
  deviceIdentifier: string;
};
const unlockInput = z.object({
  accountEmail: z.string().min(1).max(4096),
  masterPassword: z.string().min(1).max(4096),
  deviceIdentifier: z.string().uuid(),
});
type NativeState = {
  account: BitwardenNativeAccount;
  folder: string;
  revisions: Map<string, string>;
};
function revision(wire: JsonObject): string {
  const result = z.iso.datetime({ offset: true }).safeParse(wire.revisionDate);
  if (!result.success) throw nativeItemError();
  return result.data;
}
function scoped(value: BoundaryValue, state: NativeState): JsonObject {
  const wire = nativeCipherWire(value);
  if (!nativePersonalCipher(wire, state.folder))
    throw new SecretBackendError(
      "not-found",
      "The item is outside this connection's active personal folder.",
    );
  return wire;
}
function read(wire: JsonObject, state: NativeState): SecretBackendItem {
  return wire.data === null || wire.data === undefined
    ? readBitwardenLegacyItem(wire, state.account.key)
    : readBitwardenBlobItem(wire, state.account.key);
}
function observed(wire: JsonObject, state: NativeState): SecretBackendItem {
  const item = read(wire, state);
  state.revisions.set(item.id, revision(wire));
  return item;
}
function verify(input: SecretBackendItemInput, item: SecretBackendItem): void {
  const equal =
    item.name === input.name &&
    item.notes === input.notes &&
    item.secret === input.secret &&
    (input.kind === undefined || item.kind === input.kind) &&
    (input.username === undefined ||
      item.kind !== "login" ||
      item.username === input.username) &&
    (input.url === undefined ||
      item.kind !== "login" ||
      item.url === input.url) &&
    Object.entries(input.fields ?? {}).every(
      ([name, value]) => item.fields?.[name] === value,
    );
  if (!equal)
    throw new SecretBackendError(
      "response",
      "The provider did not preserve the complete encrypted item. Reconnect and reload before trying again.",
    );
}
async function list(state: NativeState): Promise<SecretBackendItem[]> {
  const result: SecretBackendItem[] = [];
  const ids = new Set<string>();
  for (const value of await state.account.sync()) {
    const wire = nativeCipherWire(value);
    if (!nativePersonalCipher(wire, state.folder)) continue;
    const id = nativeText(wire.id);
    if (ids.has(id)) throw nativeItemError();
    ids.add(id);
    result.push(observed(wire, state));
  }
  return result;
}
async function fresh(id: string, state: NativeState): Promise<JsonObject> {
  const prior = state.revisions.get(id);
  const wire = scoped(await state.account.ciphers.get(id), state);
  if (prior !== undefined && prior !== revision(wire))
    throw new SecretBackendError(
      "response",
      "This item changed remotely. Reconnect and reload it before editing or moving it to trash.",
    );
  if (wire.edit === false)
    throw new SecretBackendError("configuration", "This item is read-only.");
  return wire;
}
async function get(
  selector: string,
  state: NativeState,
): Promise<SecretBackendItem> {
  const items = await list(state);
  const exact = items.find((item) => item.id === selector);
  const matches = exact
    ? [exact]
    : items.filter((item) => item.name === selector);
  if (matches.length !== 1)
    throw new SecretBackendError(
      matches.length ? "ambiguous" : "not-found",
      matches.length
        ? "Choose an item ID because this name matches multiple items."
        : "No personal item matches this name or ID.",
    );
  const selected = matches[0];
  if (!selected) throw nativeItemError();
  return observed(
    scoped(await state.account.ciphers.get(selected.id), state),
    state,
  );
}
class BitwardenNativeBackend implements SecretBackend {
  readonly id = "bitwarden-native";
  readonly name = "Bitwarden / Vaultwarden personal account";
  readonly capabilities: SecretBackend["capabilities"] = {
    itemKinds: ["note", "login", "secret"],
    itemFields: ["username", "url", "notes", "secret"],
    vaultBackup: { kind: "note", field: "notes", maxBytes: 480 * 1024 },
    list: true,
    get: true,
    create: true,
    update: true,
    delete: true,
    import: false,
  };
  readonly #sessions = createSecretBackendSessions<NativeState>(this.id);
  constructor(
    readonly transport: SecretBackendTransport,
    readonly limits: BitwardenKdfResourceLimits,
  ) {}
  async authenticate(
    config: SecretBackendConfiguration,
  ): Promise<SecretBackendSession> {
    const parsed = unlockInput.safeParse(config);
    if (!parsed.success)
      throw new SecretBackendError(
        "configuration",
        "Enter the personal account email, master password and this connection's device identifier.",
      );
    const folder = config.vaultId.trim();
    if (folder && !z.string().uuid().safeParse(folder).success)
      throw new SecretBackendError(
        "configuration",
        "Enter a valid personal folder ID.",
      );
    if (config.organizationId.trim())
      throw new SecretBackendError(
        "configuration",
        "Choose a personal vault and folder for this connection.",
      );
    const account = await openBitwardenNativeAccount(
      {
        baseUrl: config.baseUrl,
        identityUrl: config.identityUrl,
        email: parsed.data.accountEmail,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        deviceIdentifier: parsed.data.deviceIdentifier,
      },
      parsed.data.masterPassword,
      this.limits,
      this.transport,
    );
    const state: NativeState = { account, folder, revisions: new Map() };
    try {
      await list(state);
      return this.#sessions.create(state, account.signal);
    } catch (error) {
      account.dispose();
      throw error;
    }
  }
  async listItems(session: SecretBackendSession) {
    return (await list(this.#sessions.read(session))).map(
      ({ id, name, kind }) => ({ id, name, kind }),
    );
  }
  async getItem(selector: string, session: SecretBackendSession) {
    return get(selector, this.#sessions.read(session));
  }
  async getNotes(selector: string, session: SecretBackendSession) {
    const item = await this.getItem(selector, session);
    return item.notes || item.secret;
  }
  async createItem(
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ): Promise<SecretBackendItem> {
    const state = this.#sessions.read(session);
    return this.#mutate(session, state, async () => {
      const create =
        state.account.key.algorithm === -70010
          ? createBitwardenBlobItem
          : createBitwardenLegacyItem;
      const posted = scoped(
        await state.account.ciphers.create(
          create(input, state.account.key, state.folder),
        ),
        state,
      );
      const stored = scoped(
        await state.account.ciphers.get(nativeText(posted.id)),
        state,
      );
      if (posted.key !== stored.key) throw nativeItemError();
      const item = observed(stored, state);
      verify(input, item);
      return item;
    });
  }
  async updateItem(
    id: string,
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ): Promise<SecretBackendItem> {
    const state = this.#sessions.read(session);
    return this.#mutate(session, state, async () => {
      const prior = await fresh(id, state);
      const update =
        prior.data === null || prior.data === undefined
          ? updateBitwardenLegacyItem
          : updateBitwardenBlobItem;
      const posted = scoped(
        await state.account.ciphers.update(
          id,
          update(prior, input, state.account.key),
        ),
        state,
      );
      const stored = scoped(await state.account.ciphers.get(id), state);
      if (posted.key !== prior.key || stored.key !== prior.key)
        throw nativeItemError();
      const item = observed(stored, state);
      verify(input, item);
      return item;
    });
  }
  async deleteItem(id: string, session: SecretBackendSession): Promise<void> {
    const state = this.#sessions.read(session);
    return this.#mutate(session, state, async () => {
      await fresh(id, state);
      await state.account.ciphers.trash(id);
      const rows = (await state.account.sync()).map(nativeCipherWire);
      if (rows.some((wire) => wire.id === id && !wire.deletedDate))
        throw new SecretBackendError(
          "response",
          "The provider did not confirm moving this item to trash.",
        );
      state.revisions.delete(id);
    });
  }
  async #mutate<T>(
    session: SecretBackendSession,
    state: NativeState,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      state.account.dispose();
      this.#sessions.remove(session);
      throw error;
    }
  }
  async disconnect(session: SecretBackendSession): Promise<void> {
    try {
      this.#sessions.read(session).account.dispose();
    } catch {
      /* Already ended provider sessions retain no key owner. */
    } finally {
      this.#sessions.remove(session);
    }
  }
}
export function createBitwardenNativeBackend(
  transport: SecretBackendTransport,
  limits: BitwardenKdfResourceLimits,
): SecretBackend {
  return fenceSecretBackend(
    new BitwardenNativeBackend(transport, limits),
    transport,
  );
}
