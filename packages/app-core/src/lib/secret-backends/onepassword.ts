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
  type SecretBackendItemSummary,
  type SecretBackendSession,
} from "./types.js";

const FieldSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  purpose: z.string().optional(),
  type: z.string().optional(),
  value: z.string().optional(),
});
const ItemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  category: z.string(),
  version: z.number().optional(),
  state: z.string().optional(),
  fields: z.array(FieldSchema).default([]),
  urls: z
    .array(z.object({ href: z.string(), primary: z.boolean().optional() }))
    .default([]),
});
type ConnectItem = z.infer<typeof ItemSchema>;
type ConnectState = {
  request: ReturnType<typeof createBackendHttp>;
  vaultId: string;
  headers: { Authorization: string; "Content-Type": string };
};

function summary(item: ConnectItem): SecretBackendItemSummary {
  return {
    id: item.id,
    name: item.title,
    kind:
      item.category === "LOGIN"
        ? "login"
        : item.category === "SECURE_NOTE"
          ? "note"
          : "secret",
  };
}
function connectFields(
  item: ConnectItem,
): NonNullable<SecretBackendItem["fields"]> {
  const fields: NonNullable<SecretBackendItem["fields"]> = {};
  for (const field of item.fields) {
    if (
      field.purpose ||
      field.id === "notesPlain" ||
      field.id === "opensesame_secret"
    )
      continue;
    if (field.label && field.value !== undefined)
      fields[field.label] = field.value;
  }
  return fields;
}
function normalizedItem(item: ConnectItem): SecretBackendItem {
  const notes =
    item.fields.find(
      (field) => field.id === "notesPlain" || field.purpose === "NOTES",
    )?.value ?? "";
  const password = item.fields.find(
    (field) => field.purpose === "PASSWORD" || field.id === "opensesame_secret",
  );
  return {
    ...summary(item),
    notes,
    secret: password?.value ?? "",
    username:
      item.fields.find((field) => field.purpose === "USERNAME")?.value ?? "",
    url: item.urls.find((url) => url.primary)?.href ?? item.urls[0]?.href ?? "",
    fields: connectFields(item),
  };
}
function itemBody(input: SecretBackendItemInput, vaultId: string) {
  const fields = [
    { id: "notesPlain", type: "STRING", purpose: "NOTES", value: input.notes },
    {
      id: "opensesame_secret",
      type: "CONCEALED",
      label: "Secret",
      value: input.secret,
    },
  ];
  if (input.kind === "login") {
    fields[1] = {
      id: "password",
      type: "CONCEALED",
      purpose: "PASSWORD",
      value: input.secret,
    };
    fields.push({
      id: "username",
      type: "STRING",
      purpose: "USERNAME",
      value: input.username ?? "",
    });
  }
  for (const [label, value] of Object.entries(input.fields ?? {})) {
    fields.push({ id: crypto.randomUUID(), type: "STRING", label, value });
  }
  return {
    title: input.name,
    category:
      input.kind === "login"
        ? "LOGIN"
        : input.kind === "secret"
          ? "API_CREDENTIAL"
          : "SECURE_NOTE",
    vault: { id: vaultId },
    fields,
    urls: input.url ? [{ href: input.url, primary: true }] : [],
  };
}

/** Connect is an operator-provided HTTPS API; no 1Password CLI or Node SDK is loaded. */
const path = (state: ConnectState, id = "") =>
  `v1/vaults/${encodeURIComponent(state.vaultId)}/items${id ? `/${encodeURIComponent(id)}` : ""}`;
async function list(state: ConnectState) {
  return z
    .array(ItemSchema)
    .parse(await state.request(path(state), { headers: state.headers }))
    .filter((item) => item.state !== "ARCHIVED");
}
async function get(
  state: ConnectState,
  selector: string,
): Promise<SecretBackendItem> {
  const items = await list(state);
  const byId = items.find((item) => item.id === selector);
  const matches = byId
    ? [byId]
    : items.filter((item) => item.title === selector);
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
  return normalizedItem(
    ItemSchema.parse(
      await state.request(path(state, selected.id), {
        headers: state.headers,
      }),
    ),
  );
}
class OnePasswordConnectBackend implements SecretBackend {
  readonly #sessions = createSecretBackendSessions<ConnectState>(
    "onepassword-connect",
  );
  readonly #fetcher: SecretBackendFetch | undefined;
  constructor(fetcher?: SecretBackendFetch) {
    this.#fetcher = fetcher;
  }
  readonly id = "onepassword-connect";
  readonly name = "1Password Connect";
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
    if (!config.token.trim() || !config.vaultId.trim())
      throw new SecretBackendError(
        "configuration",
        "Enter a Connect access token and vault ID.",
      );
    const state: ConnectState = {
      request: createBackendHttp(config.baseUrl, this.#fetcher),
      vaultId: config.vaultId.trim(),
      headers: {
        Authorization: `Bearer ${config.token.trim()}`,
        "Content-Type": "application/json",
      },
    };
    const vault = z.object({ id: z.string() }).parse(
      await state.request(`v1/vaults/${encodeURIComponent(state.vaultId)}`, {
        headers: state.headers,
      }),
    );
    if (vault.id !== state.vaultId)
      throw new SecretBackendError(
        "response",
        "The Connect server returned a different vault.",
      );
    return this.#sessions.create(state);
  }
  async listItems(session: SecretBackendSession) {
    return (await list(this.#sessions.read(session))).map(summary);
  }
  async getItem(selector: string, session: SecretBackendSession) {
    return get(this.#sessions.read(session), selector);
  }
  async getNotes(selector: string, session: SecretBackendSession) {
    const item = await get(this.#sessions.read(session), selector);
    return item.notes || item.secret;
  }
  async createItem(
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ) {
    const state = this.#sessions.read(session);
    return normalizedItem(
      ItemSchema.parse(
        await state.request(path(state), {
          method: "POST",
          headers: state.headers,
          body: JSON.stringify(itemBody(input, state.vaultId)),
        }),
      ),
    );
  }
  async updateItem(
    id: string,
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ) {
    const state = this.#sessions.read(session);
    const existing = ItemSchema.parse(
      await state.request(path(state, id), { headers: state.headers }),
    );
    const body = {
      ...itemBody(input, state.vaultId),
      id,
      version: existing.version,
    };
    return normalizedItem(
      ItemSchema.parse(
        await state.request(path(state, id), {
          method: "PUT",
          headers: state.headers,
          body: JSON.stringify(body),
        }),
      ),
    );
  }
  async deleteItem(id: string, session: SecretBackendSession) {
    const state = this.#sessions.read(session);
    await state.request(path(state, id), {
      method: "DELETE",
      headers: state.headers,
    });
  }
  async disconnect(session: SecretBackendSession) {
    this.#sessions.remove(session);
  }
}

export function createOnePasswordConnectBackend(
  fetcher?: SecretBackendFetch,
): SecretBackend {
  return new OnePasswordConnectBackend(fetcher);
}
