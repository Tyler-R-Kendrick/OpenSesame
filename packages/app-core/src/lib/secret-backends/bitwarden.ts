import { z } from "zod";
import { createBackendHttp } from "./http.js";
import { createSecretBackendSessions } from "./sessions.js";
import {
  type SecretBackend,
  type SecretBackendConfiguration,
  SecretBackendError,
  type SecretBackendFetch,
  type SecretBackendItem,
  type SecretBackendItemInput,
  type SecretBackendSession,
} from "./types.js";

const ItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.number(),
  notes: z.string().nullable().optional(),
  folderId: z.string().nullable().optional(),
  login: z
    .object({
      username: z.string().nullable().optional(),
      password: z.string().nullable().optional(),
      uris: z
        .array(z.object({ uri: z.string().nullable() }))
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  fields: z
    .array(
      z.object({
        name: z.string().nullable(),
        value: z.string().nullable(),
        type: z.number(),
      }),
    )
    .nullable()
    .optional(),
});
const ItemEnvelope = z.object({ success: z.literal(true), data: ItemSchema });
const ListEnvelope = z.object({
  success: z.literal(true),
  data: z.object({ data: z.array(ItemSchema) }),
});
type VaultApiItem = z.infer<typeof ItemSchema>;
type VaultApiState = {
  request: ReturnType<typeof createBackendHttp>;
  folderId: string;
  headers: { "Content-Type": string; Authorization?: string };
};

function vaultFields(
  item: VaultApiItem,
): NonNullable<SecretBackendItem["fields"]> {
  const fields: NonNullable<SecretBackendItem["fields"]> = {};
  for (const field of item.fields ?? []) {
    if (
      field.name &&
      field.name !== "opensesame_secret" &&
      field.name !== "opensesame_kind" &&
      field.value !== null
    )
      fields[field.name] = field.value;
  }
  return fields;
}
function vaultKind(item: VaultApiItem): SecretBackendItem["kind"] {
  if (item.type === 1) return "login";
  return item.fields?.some(
    (field) => field.name === "opensesame_kind" && field.value === "secret",
  )
    ? "secret"
    : "note";
}
function normalize(item: VaultApiItem): SecretBackendItem {
  return {
    id: item.id,
    name: item.name,
    kind: vaultKind(item),
    notes: item.notes ?? "",
    secret:
      item.login?.password ??
      item.fields?.find((field) => field.name === "opensesame_secret")?.value ??
      "",
    username: item.login?.username ?? "",
    url: item.login?.uris?.[0]?.uri ?? "",
    fields: vaultFields(item),
  };
}
function itemBody(input: SecretBackendItemInput, folderId: string) {
  const fields = Object.entries(input.fields ?? {}).map(([name, value]) => ({
    name,
    value,
    type: 0,
  }));
  if (input.kind !== "login" && input.secret)
    fields.push({ name: "opensesame_secret", value: input.secret, type: 1 });
  if (input.kind === "secret")
    fields.push({ name: "opensesame_kind", value: "secret", type: 0 });
  const body = {
    name: input.name,
    notes: input.notes,
    folderId: folderId || null,
    organizationId: null,
    type: input.kind === "login" ? 1 : 2,
    favorite: false,
    fields,
    login:
      input.kind === "login"
        ? {
            username: input.username ?? "",
            password: input.secret,
            uris: input.url ? [{ uri: input.url, match: null }] : [],
          }
        : null,
    secureNote: input.kind === "login" ? null : { type: 0 },
  };
  return body;
}

/** The explicitly configured Vault Management API may be backed by Bitwarden or Vaultwarden. */
async function list(state: VaultApiState) {
  return ListEnvelope.parse(
    await state.request("list/object/items", { headers: state.headers }),
  ).data.data.filter(
    (item) => !state.folderId || item.folderId === state.folderId,
  );
}
async function read(
  state: VaultApiState,
  selector: string,
): Promise<SecretBackendItem> {
  const items = await list(state);
  const idMatch = items.find((item) => item.id === selector);
  const matches = idMatch
    ? [idMatch]
    : items.filter((item) => item.name === selector);
  if (matches.length !== 1)
    throw new SecretBackendError(
      matches.length ? "ambiguous" : "not-found",
      matches.length
        ? "Choose an item by ID because this name matches more than one item."
        : "No item matches this name or ID.",
    );
  const selected = matches[0];
  if (!selected)
    throw new SecretBackendError("not-found", "The item was not found.");
  return normalize(
    ItemEnvelope.parse(
      await state.request(`object/item/${encodeURIComponent(selected.id)}`, {
        headers: state.headers,
      }),
    ).data,
  );
}
class BitwardenApiBackend implements SecretBackend {
  readonly #sessions =
    createSecretBackendSessions<VaultApiState>("bitwarden-api");
  readonly #fetcher: SecretBackendFetch | undefined;
  constructor(fetcher?: SecretBackendFetch) {
    this.#fetcher = fetcher;
  }
  readonly id = "bitwarden-api";
  readonly name = "Bitwarden Vault Management API";
  readonly capabilities: SecretBackend["capabilities"] = {
    itemKinds: ["note", "login", "secret"],
    vaultBackup: { kind: "note", field: "notes" },
    list: true,
    get: true,
    create: true,
    update: true,
    delete: true,
    import: false,
  };
  async authenticate(config: SecretBackendConfiguration) {
    const headers: VaultApiState["headers"] = {
      "Content-Type": "application/json",
    };
    if (config.token.trim())
      headers.Authorization = `Bearer ${config.token.trim()}`;
    const state: VaultApiState = {
      request: createBackendHttp(config.baseUrl, this.#fetcher),
      headers,
      folderId: config.vaultId.trim(),
    };
    const status = z
      .object({
        success: z.literal(true),
        data: z.object({ status: z.string() }),
      })
      .parse(await state.request("status", { headers }));
    if (status.data.status !== "unlocked")
      throw new SecretBackendError(
        "locked",
        "Unlock the configured Bitwarden API vault before connecting.",
      );
    return this.#sessions.create(state);
  }
  async listItems(session: SecretBackendSession) {
    return (await list(this.#sessions.read(session))).map((item) => {
      const { id, name, kind } = normalize(item);
      return { id, name, kind };
    });
  }
  async getItem(selector: string, session: SecretBackendSession) {
    return read(this.#sessions.read(session), selector);
  }
  async getNotes(selector: string, session: SecretBackendSession) {
    const item = await read(this.#sessions.read(session), selector);
    return item.notes || item.secret;
  }
  async createItem(
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ) {
    const state = this.#sessions.read(session);
    return normalize(
      ItemEnvelope.parse(
        await state.request("object/item", {
          method: "POST",
          headers: state.headers,
          body: JSON.stringify(itemBody(input, state.folderId)),
        }),
      ).data,
    );
  }
  async updateItem(
    id: string,
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ) {
    const state = this.#sessions.read(session);
    await read(state, id);
    return normalize(
      ItemEnvelope.parse(
        await state.request(`object/item/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: state.headers,
          body: JSON.stringify({ ...itemBody(input, state.folderId), id }),
        }),
      ).data,
    );
  }
  async deleteItem(id: string, session: SecretBackendSession) {
    const state = this.#sessions.read(session);
    await read(state, id);
    await state.request(`object/item/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: state.headers,
    });
  }
  async disconnect(session: SecretBackendSession) {
    this.#sessions.remove(session);
  }
}

export function createBitwardenApiBackend(
  fetcher?: SecretBackendFetch,
): SecretBackend {
  return new BitwardenApiBackend(fetcher);
}
