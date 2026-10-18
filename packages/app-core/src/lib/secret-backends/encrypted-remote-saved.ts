import type { CredentialItem } from "@opensesame/vault-core";
import { readDeviceRows } from "../device-connector-records.js";
import { vaultCredentialField } from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import { readSecretBackendCredentialItems } from "./credential-custody.js";
import {
  encryptedRemoteContinuityError,
  readEncryptedRemoteContinuity,
} from "./encrypted-remote-codec.js";
import { createEncryptedRemoteContinuity } from "./encrypted-remote-continuity.js";
import { createEncryptedRemoteBackend } from "./encrypted-remote.js";
import { validateSecretBackendDraft } from "./schema.js";
import {
  readSecretBackendConnection,
  secretBackendRuntimeConfiguration,
} from "./store.js";
import type { SecretBackendTransport } from "./transport.js";
import {
  type SecretBackend,
  type SecretBackendConfiguration,
  SecretBackendError,
} from "./types.js";

/** Saved encrypted objects always use their actual portable vault key's continuity. */
export function createSavedEncryptedRemoteBackend(
  transport: SecretBackendTransport,
  connectionId?: string,
): SecretBackend {
  transport.assertCurrent();
  if (!connectionId)
    throw new SecretBackendError(
      "configuration",
      "Save this encrypted remote configuration before connecting or initializing it.",
    );
  const tomb = vaultStore.getSnapshot().tomb;
  let delegate: ReturnType<typeof createEncryptedRemoteBackend> | undefined;
  const saved = () => {
    transport.assertCurrent();
    transport.signal.throwIfAborted();
    const config = secretBackendRuntimeConfiguration(connectionId, tomb);
    if (!config || config.mode !== "encrypted-remote")
      throw encryptedRemoteContinuityError();
    return config;
  };
  const readKey = (): CredentialItem => {
    const config = saved();
    const draft = readSecretBackendConnection(connectionId);
    const row = readDeviceRows().find(
      (item) => item.connectionId === connectionId,
    );
    if (!draft || !row) throw encryptedRemoteContinuityError();
    const key = readSecretBackendCredentialItems(
      draft,
      tomb,
      row.fields.secret_backend_credentials ?? "",
    ).find((item) => vaultCredentialField(item) === "encryptionKey");
    if (
      !key ||
      key.method.type !== "token" ||
      key.method.token !== config.encryptionKey
    )
      throw encryptedRemoteContinuityError();
    return key;
  };
  const prepare = (input: SecretBackendConfiguration, initialize = false) => {
    const config = saved();
    if (
      JSON.stringify(validateSecretBackendDraft(input)) !==
      JSON.stringify(config)
    )
      throw new SecretBackendError(
        "stale",
        "Save configuration changes before connecting.",
      );
    if (
      initialize &&
      readEncryptedRemoteContinuity(readKey(), {
        objectUrl: new URL(config.baseUrl).href,
        storeId: config.remoteStoreId ?? "",
      }).revision !== 0
    )
      throw new SecretBackendError(
        "stale",
        "This key has authenticated a remote inventory. Restore that object instead of initializing it again.",
      );
    delegate ??= createEncryptedRemoteBackend(
      transport,
      createEncryptedRemoteContinuity(readKey, transport),
    );
    return delegate;
  };
  const held = () => {
    transport.assertCurrent();
    if (!delegate) throw encryptedRemoteContinuityError();
    return delegate;
  };
  return {
    id: "encrypted-remote",
    name: "Encrypted remote object",
    signal: transport.signal,
    capabilities: {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
      import: false,
      itemKinds: ["note", "login", "secret"],
      itemFields: ["username", "url", "notes", "secret"],
      vaultBackup: { kind: "note", field: "notes" },
    },
    authenticate: (config) => prepare(config).authenticate(config),
    initialize: (config) => prepare(config, true).initialize(config),
    listItems: (session) => held().listItems(session),
    getItem: (name, session) => held().getItem(name, session),
    getNotes: (name, session) => held().getNotes(name, session),
    createItem: (input, session) => held().createItem(input, session),
    updateItem: (id, input, session) => held().updateItem(id, input, session),
    deleteItem: (id, session) => held().deleteItem(id, session),
    disconnect: async (session) => {
      await delegate?.disconnect(session);
    },
  };
}
