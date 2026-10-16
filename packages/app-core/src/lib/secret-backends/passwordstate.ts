import { createBackendHttp } from "./http.js";
import {
  passwordstateId,
  passwordstateItem,
  passwordstateRows,
  passwordstateSummary,
  passwordstateWrite,
} from "./passwordstate-codec.js";
import { createSecretBackendSessions } from "./sessions.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendFetch,
  type SecretBackendSession,
} from "./types.js";

type PasswordstateState = {
  request: ReturnType<typeof createBackendHttp>;
  listId: string;
  apiKey: string;
};

const listPath = (id: string) =>
  `/api/passwords/${id}?QueryAll&ExcludePassword=True`;

type PasswordstateSessions = ReturnType<
  typeof createSecretBackendSessions<PasswordstateState>
>;

function passwordstateClient(sessions: PasswordstateSessions) {
  async function call(
    session: SecretBackendSession,
    path: string,
    init: RequestInit = {},
  ) {
    const state = sessions.read(session);
    const headers = new Headers(init.headers);
    headers.set("APIKey", state.apiKey);
    const result = await state.request(path, { ...init, headers });
    sessions.read(session);
    return result;
  }
  async function listItems(session: SecretBackendSession) {
    const body = await call(session, listPath(sessions.read(session).listId));
    return passwordstateRows(body).map(passwordstateSummary);
  }
  async function resolveId(name: string, session: SecretBackendSession) {
    const rows = await listItems(session);
    const id = rows.find((row) => row.id === name);
    if (id) return id.id;
    const names = rows.filter((row) => row.name === name);
    if (names.length === 1 && names[0]) return names[0].id;
    if (names.length > 1)
      throw new SecretBackendError(
        "ambiguous",
        "More than one Passwordstate record has that title. Select its record ID.",
      );
    throw new SecretBackendError(
      "not-found",
      "No matching password exists in the configured Passwordstate list.",
    );
  }
  async function getItem(name: string, session: SecretBackendSession) {
    const id = await resolveId(name, session);
    const item = passwordstateItem(await call(session, `/api/passwords/${id}`));
    if (item.id !== id)
      throw new SecretBackendError(
        "response",
        "Passwordstate returned a different password record.",
      );
    return item;
  }
  return { call, listItems, resolveId, getItem };
}

/** Standard Passwordstate API keys, scoped to the list the person configured. */
export function createPasswordstateBackend(
  fetcher?: SecretBackendFetch,
): SecretBackend {
  const sessions =
    createSecretBackendSessions<PasswordstateState>("passwordstate");
  const { call, listItems, resolveId, getItem } = passwordstateClient(sessions);

  return {
    id: "passwordstate",
    name: "Passwordstate",
    capabilities: {
      itemKinds: ["login"],
      vaultBackup: { kind: "login", field: "notes" },
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
      import: false,
    },
    async authenticate(config) {
      if (
        !/^[1-9][0-9]{0,14}$/.test(config.passwordListId.trim()) ||
        !config.token.trim()
      )
        throw new SecretBackendError(
          "configuration",
          "Enter a Passwordstate password list ID and API key.",
        );
      const listId = config.passwordListId.trim();
      const apiKey = config.token.trim();
      const request = createBackendHttp(config.baseUrl, fetcher);
      const rows = await request(listPath(listId), {
        headers: { APIKey: apiKey },
      });
      passwordstateRows(rows).forEach(passwordstateSummary);
      return sessions.create({ request, listId, apiKey });
    },
    listItems,
    getItem,
    async getNotes(name, session) {
      return (await getItem(name, session)).notes;
    },
    async createItem(item, session) {
      const state = sessions.read(session);
      const body = {
        ...passwordstateWrite(item),
        PasswordListID: Number(state.listId),
        PasswordResetEnabled: false,
      };
      return passwordstateItem(
        await call(session, "/api/passwords", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    async updateItem(id, item, session) {
      const recordId = await resolveId(id, session);
      const body = {
        ...passwordstateWrite(item),
        PasswordID: Number(recordId),
      };
      const updated = passwordstateItem(
        await call(session, "/api/passwords", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      if (updated.id !== recordId)
        throw new SecretBackendError(
          "response",
          "Passwordstate updated a different password record.",
        );
      return updated;
    },
    async deleteItem(id, session) {
      const recordId = passwordstateId(await resolveId(id, session));
      await call(session, `/api/passwords/${recordId}?MoveToRecycleBin=True`, {
        method: "DELETE",
      });
    },
    async disconnect(session) {
      sessions.remove(session);
    },
  };
}
