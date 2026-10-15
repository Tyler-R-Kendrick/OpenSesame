import type { JsonValue } from "@opensesame/os-domain";
import { z } from "zod";
import { secretBackendUrl } from "./http.js";
import {
  onePasswordSdkSelect,
  onePasswordSdkSummaries,
  readOnePasswordSdkItem,
} from "./onepassword-sdk-codec.js";
import {
  type OnePasswordSdkClient,
  createBrowserOnePasswordClient,
} from "./onepassword-sdk-loader.js";
import {
  type OnePasswordAssets,
  OnePasswordAssetsSchema,
  type OnePasswordCommand,
  OnePasswordSettingsSchema,
} from "./onepassword-worker-protocol.js";
import { awaitSecretBackendOwner } from "./runtime-guard.js";
import { createSecretBackendSessions } from "./sessions.js";
import {
  type SecretBackendTransport,
  guardSecretBackendTransport,
} from "./transport.js";
import {
  type SecretBackend,
  type SecretBackendConfiguration,
  SecretBackendError,
  type SecretBackendSession,
} from "./types.js";

const Id = z.string().min(1).max(1024);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Vaults = z
  .array(
    z.object({
      id: Id,
      title: z.string().max(16_384),
      description: z.string().max(16_384),
      vaultType: z.enum([
        "personal",
        "everyone",
        "transfer",
        "userCreated",
        "unsupported",
      ]),
      activeItemCount: Count,
      contentVersion: Count,
      attributeVersion: Count,
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    }),
  )
  .max(4096);
type State = {
  client: OnePasswordSdkClient | undefined;
  vaultId: string;
  dispose(): Promise<void>;
};
type ClientFactory = typeof createBrowserOnePasswordClient;

function ownClient(client: OnePasswordSdkClient, vaultId: string): State {
  let disposal: Promise<void> | undefined;
  const state: State = {
    client,
    vaultId,
    dispose() {
      if (!disposal) {
        const owned = state.client;
        state.client = undefined;
        disposal = Promise.resolve().then(() => owned?.dispose());
      }
      return disposal;
    },
  };
  return state;
}

function ended(): SecretBackendError {
  return new SecretBackendError(
    "stale",
    "This native 1Password session ended. Connect again.",
  );
}
function configuration(): never {
  throw new SecretBackendError(
    "configuration",
    "Check the native 1Password token, account origin, vault ID and owned assets.",
  );
}
function response(): never {
  throw new SecretBackendError(
    "response",
    "1Password could not complete the native vault operation.",
  );
}
function settings(config: SecretBackendConfiguration) {
  try {
    const url = secretBackendUrl(config.baseUrl);
    if (url.pathname !== "/" || !config.token.trim() || !config.vaultId.trim())
      configuration();
    const parsed = OnePasswordSettingsSchema.safeParse({
      serviceAccountToken: config.token,
      accountOrigin: url.origin,
      vaultId: config.vaultId,
    });
    if (!parsed.success) configuration();
    return parsed.data;
  } catch {
    return configuration();
  }
}
function accessibleVault(value: JsonValue, vaultId: string): void {
  const parsed = Vaults.safeParse(value);
  if (!parsed.success) response();
  const ids = parsed.data.map((vault) => vault.id);
  if (new Set(ids).size !== ids.length || !ids.includes(vaultId)) response();
}
async function invoke(
  client: OnePasswordSdkClient,
  command: OnePasswordCommand,
  signal: AbortSignal,
) {
  try {
    return await awaitSecretBackendOwner(client.invoke(command), signal);
  } catch {
    if (signal.aborted) throw ended();
    return response();
  }
}

/** Unactivated native SDK adapter; the host supplies pinned assets and one captured capability. */
export function createOnePasswordSdkBackend(
  assets: OnePasswordAssets,
  transport: SecretBackendTransport,
  clientFactory: ClientFactory = createBrowserOnePasswordClient,
): SecretBackend {
  const parsed = OnePasswordAssetsSchema.safeParse(assets);
  if (!parsed.success) configuration();
  return new OnePasswordSdkBackend(
    parsed.data,
    Object.freeze(guardSecretBackendTransport(transport)),
    clientFactory,
  );
}
class OnePasswordSdkBackend implements SecretBackend {
  readonly id = "onepassword-sdk";
  readonly name = "1Password native SDK";
  readonly capabilities: SecretBackend["capabilities"] = {
    itemKinds: ["note", "login", "secret"],
    itemFields: ["username", "url", "notes", "secret"],
    list: true,
    get: true,
    create: false,
    update: false,
    delete: false,
    import: false,
  };
  readonly #sessions = createSecretBackendSessions<State>(this.id);
  readonly #cleanup = new WeakMap<SecretBackendSession, () => Promise<void>>();
  readonly signal: AbortSignal;
  constructor(
    private readonly assets: OnePasswordAssets,
    private readonly transport: SecretBackendTransport,
    private readonly clientFactory: ClientFactory,
  ) {
    this.signal = transport.signal;
  }
  #check(): void {
    try {
      this.transport.assertCurrent();
    } catch {
      throw ended();
    }
    if (this.signal.aborted) throw ended();
  }
  #owned(session: SecretBackendSession) {
    this.#check();
    if (session.signal?.aborted) throw ended();
    const state = this.#sessions.read(session);
    const client = state.client;
    if (!client || client.closed.aborted) throw ended();
    return { state, client };
  }
  #admit(state: State): SecretBackendSession {
    const client = state.client;
    this.#check();
    if (!client || client.closed.aborted) throw ended();
    const session = this.#sessions.create(state, client.closed);
    let disposal: Promise<void> | undefined;
    const cleanup = () => {
      if (disposal) return disposal;
      disposal = Promise.resolve().then(() => state.dispose());
      void disposal.catch(() => undefined);
      this.signal.removeEventListener("abort", terminate);
      session.signal?.removeEventListener("abort", terminate);
      this.#sessions.remove(session);
      return disposal;
    };
    const terminate = () => {
      void cleanup().catch(() => undefined);
    };
    this.#cleanup.set(session, cleanup);
    this.signal.addEventListener("abort", terminate, { once: true });
    if (!disposal)
      session.signal?.addEventListener("abort", terminate, { once: true });
    try {
      this.#owned(session);
      return session;
    } catch (error) {
      terminate();
      throw error;
    }
  }
  async authenticate(
    config: SecretBackendConfiguration,
  ): Promise<SecretBackendSession> {
    this.#check();
    const input = settings(config);
    let client: OnePasswordSdkClient;
    try {
      client = await awaitSecretBackendOwner(
        this.clientFactory(input, this.assets, this.transport, this.signal),
        this.signal,
        (late) => late.dispose(),
      );
    } catch {
      this.#check();
      return response();
    }
    const state = ownClient(client, input.vaultId);
    let admitted = false;
    try {
      const signal = AbortSignal.any([this.signal, client.closed]);
      this.#check();
      if (signal.aborted) throw ended();
      const vaults = await invoke(client, { name: "VaultsList" }, signal);
      this.#check();
      if (signal.aborted) throw ended();
      accessibleVault(vaults, input.vaultId);
      const items = await invoke(client, { name: "ItemsList" }, signal);
      this.#check();
      if (signal.aborted) throw ended();
      onePasswordSdkSummaries(items, input.vaultId);
      const session = this.#admit(state);
      admitted = true;
      return session;
    } finally {
      if (!admitted) void state.dispose().catch(() => undefined);
    }
  }
  async #call(session: SecretBackendSession, command: OnePasswordCommand) {
    const { client } = this.#owned(session);
    const signals = [this.signal, client.closed];
    if (session.signal) signals.push(session.signal);
    const result = await invoke(client, command, AbortSignal.any(signals));
    this.#owned(session);
    return result;
  }
  async listItems(session: SecretBackendSession) {
    const { state } = this.#owned(session);
    const items = onePasswordSdkSummaries(
      await this.#call(session, { name: "ItemsList" }),
      state.vaultId,
    );
    this.#owned(session);
    return items;
  }
  async getItem(selector: string, session: SecretBackendSession) {
    const { state } = this.#owned(session);
    const rows = await this.#call(session, { name: "ItemsList" });
    const itemId = onePasswordSdkSelect(rows, state.vaultId, selector);
    const item = readOnePasswordSdkItem(
      await this.#call(session, { name: "ItemsGet", itemId }),
      state.vaultId,
      itemId,
    );
    this.#owned(session);
    return item.normalized;
  }
  async getNotes(selector: string, session: SecretBackendSession) {
    const item = await this.getItem(selector, session);
    this.#owned(session);
    return item.notes || item.secret;
  }
  disconnect(session: SecretBackendSession): Promise<void> {
    const cleanup = this.#cleanup.get(session);
    if (!cleanup)
      return Promise.reject(
        new SecretBackendError(
          "authentication",
          "This session belongs to another native 1Password backend.",
        ),
      );
    return cleanup();
  }
}
