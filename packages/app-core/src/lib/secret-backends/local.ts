import { FIELD_LIMITS } from "../vault/field-limits.js";
import {
  isLocalSecretItem,
  localItemView,
  localItemWrite,
  namedLocalItem,
} from "./local-items.js";
import {
  type LocalVaultPort,
  localVaultPort,
  localVaultSessionGuard,
} from "./local-vault-port.js";
import { createSecretBackendSessions } from "./sessions.js";
import type { SecretBackend } from "./types.js";

export function createLocalVaultBackend(port?: LocalVaultPort): SecretBackend {
  const id = "local";
  const sessions = createSecretBackendSessions<{
    port: LocalVaultPort;
    guard: ReturnType<typeof localVaultSessionGuard>;
  }>(id);
  const state = (session: Parameters<typeof sessions.read>[0]) => {
    const held = sessions.read(session);
    held.guard.current();
    return held;
  };
  const items = (session: Parameters<typeof sessions.read>[0]) =>
    state(session).guard.current().items.filter(isLocalSecretItem);
  return {
    id,
    name: "This encrypted vault",
    capabilities: {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
      import: false,
      itemKinds: ["note", "login", "secret"],
      vaultBackup: {
        kind: "note",
        field: "notes",
        maxBytes: FIELD_LIMITS.text,
      },
    },
    async authenticate() {
      const store = await localVaultPort(port);
      return sessions.create({
        port: store,
        guard: localVaultSessionGuard(store),
      });
    },
    async listItems(session) {
      return items(session).map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind === "account" ? "login" : item.kind,
      }));
    },
    async getItem(reference, session) {
      return localItemView(namedLocalItem(items(session), reference));
    },
    async getNotes(reference, session) {
      return namedLocalItem(items(session), reference).notes;
    },
    async createItem(input, session) {
      const held = state(session);
      const item = localItemWrite(input);
      await held.port.saveItem(item);
      held.guard.current();
      return localItemView(item);
    },
    async updateItem(id, input, session) {
      const held = state(session);
      const item = localItemWrite(input, namedLocalItem(items(session), id));
      await held.port.saveItem(item);
      held.guard.current();
      return localItemView(item);
    },
    async deleteItem(id, session) {
      const held = state(session);
      const item = namedLocalItem(items(session), id);
      await held.port.trashItem(item.id);
      held.guard.current();
    },
    async disconnect(session) {
      sessions.read(session).guard.close();
      sessions.remove(session);
    },
  };
}
