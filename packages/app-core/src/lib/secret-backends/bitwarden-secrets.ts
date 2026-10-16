import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { z } from "zod";
import {
  type BitwardenSdkClient,
  type BitwardenSdkFactory,
  createBrowserBitwardenClient,
} from "./bitwarden-wasm-loader.js";
import { secretBackendUrl } from "./http.js";
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

const IdentifierSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  key: z.string(),
});
const SecretSchema = IdentifierSchema.extend({
  value: z.string(),
  note: z.string(),
  projectId: z.string().nullable().optional(),
});
type SecretsState = {
  client: BitwardenSdkClient;
  organizationId: string;
  projectId: string;
};
type NativeSecret = z.infer<typeof SecretSchema>;

async function command(
  client: BitwardenSdkClient,
  request: JsonObject,
): Promise<BoundaryValue> {
  let response: BoundaryValue;
  try {
    const raw = await client.run_command(JSON.stringify(request));
    if (!isString(raw))
      throw new SecretBackendError(
        "response",
        "Bitwarden returned an invalid SDK response.",
      );
    response = JSON.parse(raw);
  } catch {
    throw new SecretBackendError(
      "response",
      "The Bitwarden SDK could not complete this operation.",
    );
  }
  if (
    !isJsonObject(response) ||
    response.success !== true ||
    response.data === undefined
  ) {
    // Native error bodies may contain request details; expose no raw provider response.
    throw new SecretBackendError(
      "response",
      "Bitwarden refused this operation. Check the token, scope and permissions.",
    );
  }
  return response.data;
}
function item(secret: NativeSecret): SecretBackendItem {
  return {
    id: secret.id,
    name: secret.key,
    kind: "secret",
    notes: secret.note,
    secret: secret.value,
  };
}
function inScope(secret: NativeSecret, state: SecretsState): void {
  if (
    secret.organizationId !== state.organizationId ||
    (state.projectId && secret.projectId !== state.projectId)
  ) {
    throw new SecretBackendError(
      "not-found",
      "This secret is outside the configured organization or project.",
    );
  }
}
function body(input: SecretBackendItemInput, state: SecretsState): JsonObject {
  if (input.username || input.url || Object.keys(input.fields ?? {}).length) {
    throw new SecretBackendError(
      "unsupported",
      "Secrets Manager stores a name, secret value and note. Use a password-manager backend for login fields.",
    );
  }
  const value = input.secret || input.notes;
  const note = input.secret ? input.notes : "";
  if (
    !input.name.trim() ||
    input.name.length > 500 ||
    !value ||
    value.length > 25_000 ||
    note.length > 7_000
  ) {
    throw new SecretBackendError(
      "configuration",
      "Secrets Manager requires a name up to 500 characters, a value up to 25,000 and a note up to 7,000.",
    );
  }
  return {
    organizationId: state.organizationId,
    key: input.name,
    value,
    note,
    projectIds: state.projectId ? [state.projectId] : [],
  };
}

/** Official WASM owns authentication, organization keys and authenticated secret encryption. */
async function getById(state: SecretsState, id: string) {
  const secret = SecretSchema.parse(
    await command(state.client, { secrets: { get: { id } } }),
  );
  inScope(secret, state);
  return secret;
}
async function list(state: SecretsState) {
  const data = z.object({ data: z.array(IdentifierSchema) }).parse(
    await command(state.client, {
      secrets: { list: { organizationId: state.organizationId } },
    }),
  );
  const identifiers = data.data.filter(
    (entry) => entry.organizationId === state.organizationId,
  );
  if (!state.projectId) return identifiers;
  const selected = [];
  for (const identifier of identifiers) {
    const secret = SecretSchema.parse(
      await command(state.client, {
        secrets: { get: { id: identifier.id } },
      }),
    );
    if (
      secret.organizationId === state.organizationId &&
      secret.projectId === state.projectId
    )
      selected.push(identifier);
  }
  return selected;
}
async function get(state: SecretsState, selector: string) {
  const identifiers = await list(state);
  const idMatch = identifiers.find((entry) => entry.id === selector);
  const matches = idMatch
    ? [idMatch]
    : identifiers.filter((entry) => entry.key === selector);
  if (matches.length !== 1)
    throw new SecretBackendError(
      matches.length ? "ambiguous" : "not-found",
      matches.length
        ? "Choose a secret by ID because this name matches more than one secret."
        : "No secret matches this name or ID.",
    );
  const selected = matches[0];
  if (!selected)
    throw new SecretBackendError("not-found", "The secret was not found.");
  return item(await getById(state, selected.id));
}
class BitwardenSecretsBackend implements SecretBackend {
  readonly #sessions =
    createSecretBackendSessions<SecretsState>("bitwarden-secrets");
  readonly #fetcher: SecretBackendFetch | undefined;
  readonly #createClient: BitwardenSdkFactory | undefined;
  readonly #signal: AbortSignal | undefined;
  constructor(
    fetcher?: SecretBackendFetch,
    createClient?: BitwardenSdkFactory,
    signal?: AbortSignal,
  ) {
    this.#fetcher = fetcher;
    this.#createClient = createClient;
    this.#signal = signal;
  }
  readonly id = "bitwarden-secrets";
  readonly name = "Bitwarden Secrets Manager";
  readonly capabilities: SecretBackend["capabilities"] = {
    itemKinds: ["secret"],
    vaultBackup: { kind: "secret", field: "secret", maxBytes: 25_000 },
    list: true,
    get: true,
    create: true,
    update: true,
    delete: true,
    import: false,
  };
  async authenticate(config: SecretBackendConfiguration) {
    const organizationId = z
      .string()
      .uuid()
      .parse(config.organizationId)
      .toLowerCase();
    const projectId = config.projectId
      ? z.string().uuid().parse(config.projectId).toLowerCase()
      : "";
    if (!/^0\.[0-9a-f-]+\.[^:]+:[A-Za-z0-9+/]+=*$/i.test(config.token))
      throw new SecretBackendError(
        "configuration",
        "Enter the complete Secrets Manager machine-account access token.",
      );
    const apiUrl = secretBackendUrl(
      config.baseUrl || "https://api.bitwarden.com",
    ).href.replace(/\/$/, "");
    if (
      !config.identityUrl &&
      !["api.bitwarden.com", "api.bitwarden.eu"].includes(
        new URL(apiUrl).hostname,
      )
    ) {
      throw new SecretBackendError(
        "configuration",
        "Configure the identity URL for this self-hosted Secrets Manager API.",
      );
    }
    const identityUrl = secretBackendUrl(
      config.identityUrl ||
        (new URL(apiUrl).hostname === "api.bitwarden.eu"
          ? "https://identity.bitwarden.eu"
          : "https://identity.bitwarden.com"),
    ).href.replace(/\/$/, "");
    this.#signal?.throwIfAborted();
    const factory: BitwardenSdkFactory =
      this.#createClient ??
      ((settings) =>
        createBrowserBitwardenClient(settings, this.#fetcher, this.#signal));
    const client = await factory({ apiUrl, identityUrl });
    try {
      // The published 0.1.0 WASM uses accessTokenLogin, not the renamed modern binding.
      const auth = z.object({ authenticated: z.boolean() }).parse(
        await command(client, {
          accessTokenLogin: { accessToken: config.token },
        }),
      );
      if (!auth.authenticated)
        throw new SecretBackendError(
          "authentication",
          "Bitwarden did not authenticate this machine account.",
        );
      const state = { client, organizationId, projectId };
      await list(state);
      return this.#sessions.create(state);
    } catch (error) {
      client.free();
      throw error;
    }
  }
  async listItems(
    session: SecretBackendSession,
  ): Promise<SecretBackendItemSummary[]> {
    return (await list(this.#sessions.read(session))).map((entry) => ({
      id: entry.id,
      name: entry.key,
      kind: "secret",
    }));
  }
  async getItem(selector: string, session: SecretBackendSession) {
    return get(this.#sessions.read(session), selector);
  }
  async getNotes(selector: string, session: SecretBackendSession) {
    const secret = await get(this.#sessions.read(session), selector);
    return secret.notes || secret.secret;
  }
  async createItem(
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ) {
    const state = this.#sessions.read(session);
    const created = SecretSchema.parse(
      await command(state.client, {
        secrets: { create: body(input, state) },
      }),
    );
    inScope(created, state);
    return item(created);
  }
  async updateItem(
    id: string,
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ) {
    const state = this.#sessions.read(session);
    await getById(state, id);
    const updated = SecretSchema.parse(
      await command(state.client, {
        secrets: { update: { ...body(input, state), id } },
      }),
    );
    inScope(updated, state);
    return item(updated);
  }
  async deleteItem(id: string, session: SecretBackendSession) {
    const state = this.#sessions.read(session);
    await getById(state, id);
    const result = z
      .object({
        data: z.array(
          z.object({
            id: z.string(),
            error: z.string().nullable().optional(),
          }),
        ),
      })
      .parse(
        await command(state.client, { secrets: { delete: { ids: [id] } } }),
      );
    const deleted = result.data.find((entry) => entry.id === id);
    if (!deleted || deleted.error)
      throw new SecretBackendError(
        "response",
        "Bitwarden did not delete this secret.",
      );
  }
  async disconnect(session: SecretBackendSession) {
    const state = this.#sessions.read(session);
    this.#sessions.remove(session);
    state.client.free();
  }
}

export function createBitwardenSecretsBackend(
  fetcher?: SecretBackendFetch,
  createClient?: BitwardenSdkFactory,
  signal?: AbortSignal,
): SecretBackend {
  return new BitwardenSecretsBackend(fetcher, createClient, signal);
}
