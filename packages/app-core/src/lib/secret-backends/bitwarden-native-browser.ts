import { z } from "zod";
import {
  bitwardenNativeCapabilities,
  bitwardenNativeUnlockInput,
} from "./bitwarden-native-contract.js";
import {
  type BitwardenNativeClient,
  type NativeWorkerCommand,
  createBrowserBitwardenNativeClient,
} from "./bitwarden-native-worker-client.js";
import {
  type NativeWorkerSettings,
  NativeWorkerValue,
} from "./bitwarden-native-worker-protocol.js";
import { createSecretBackendSessions } from "./sessions.js";
import {
  type SecretBackendTransport,
  fenceSecretBackend,
  guardSecretBackendTransport,
} from "./transport.js";
import {
  type SecretBackend,
  type SecretBackendConfiguration,
  SecretBackendError,
  type SecretBackendSession,
} from "./types.js";

type ClientFactory = typeof createBrowserBitwardenNativeClient;
function settings(config: SecretBackendConfiguration): NativeWorkerSettings {
  const parsed = bitwardenNativeUnlockInput.safeParse(config);
  if (
    !parsed.success ||
    config.organizationId.trim() ||
    (config.vaultId && !z.string().uuid().safeParse(config.vaultId).success)
  )
    throw new SecretBackendError(
      "configuration",
      "Enter the personal account email, API credentials, device identifier and master password; choose a personal folder if needed.",
    );
  return {
    ...parsed.data,
    providerId: config.providerId,
    name: config.name,
    baseUrl: config.baseUrl,
    identityUrl: config.identityUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    vaultId: config.vaultId,
  };
}
function invalid(client: BitwardenNativeClient): never {
  client.dispose();
  throw new SecretBackendError(
    "response",
    "The native worker returned an invalid item operation result.",
  );
}
async function result<T>(
  client: BitwardenNativeClient,
  command: NativeWorkerCommand,
  schema: z.ZodType<T>,
): Promise<T> {
  const parsed = schema.safeParse(await client.invoke(command));
  if (!parsed.success) return invalid(client);
  return parsed.data;
}
class NativeBrowserBackend implements SecretBackend {
  readonly id = "bitwarden-native";
  readonly name = "Bitwarden / Vaultwarden personal account";
  readonly capabilities = bitwardenNativeCapabilities;
  readonly #sessions = createSecretBackendSessions<{
    client: BitwardenNativeClient;
  }>(this.id);
  constructor(
    private readonly transport: SecretBackendTransport,
    private readonly clientFactory: ClientFactory,
  ) {}
  async authenticate(
    config: SecretBackendConfiguration,
  ): Promise<SecretBackendSession> {
    const input = settings(config);
    let client: BitwardenNativeClient | undefined;
    try {
      client = await this.clientFactory(input, this.transport);
      this.transport.assertCurrent();
      if (this.transport.signal.aborted)
        throw new SecretBackendError("stale", "The native connection ended.");
      return this.#sessions.create({ client }, client.closed);
    } catch (error) {
      client?.dispose();
      throw error;
    } finally {
      input.masterPassword = "";
      input.clientSecret = "";
    }
  }
  async getItem(selector: string, session: SecretBackendSession) {
    return result(
      this.#sessions.read(session).client,
      { type: "get", selector },
      NativeWorkerValue.options[0],
    );
  }
  async getNotes(selector: string, session: SecretBackendSession) {
    return result(
      this.#sessions.read(session).client,
      { type: "notes", selector },
      NativeWorkerValue.options[2],
    );
  }
  async listItems(session: SecretBackendSession) {
    return result(
      this.#sessions.read(session).client,
      { type: "list" },
      NativeWorkerValue.options[1],
    );
  }
  async createItem(
    item: Parameters<NonNullable<SecretBackend["createItem"]>>[0],
    session: SecretBackendSession,
  ) {
    return result(
      this.#sessions.read(session).client,
      { type: "create", item },
      NativeWorkerValue.options[0],
    );
  }
  async updateItem(
    itemId: string,
    item: Parameters<NonNullable<SecretBackend["updateItem"]>>[1],
    session: SecretBackendSession,
  ) {
    return result(
      this.#sessions.read(session).client,
      { type: "update", itemId, item },
      NativeWorkerValue.options[0],
    );
  }
  async deleteItem(
    itemId: string,
    session: SecretBackendSession,
  ): Promise<void> {
    await result(
      this.#sessions.read(session).client,
      { type: "delete", itemId },
      NativeWorkerValue.options[3],
    );
  }
  async disconnect(session: SecretBackendSession): Promise<void> {
    try {
      this.#sessions.read(session).client.dispose();
    } catch {
      /* Ended handles retain no worker owner. */
    } finally {
      this.#sessions.remove(session);
    }
  }
}
/** The common port holds opaque worker handles; all account cryptography stays in its disposable realm. */
export function createBitwardenNativeBrowserBackend(
  transport: SecretBackendTransport,
  clientFactory: ClientFactory = createBrowserBitwardenNativeClient,
): SecretBackend {
  const captured = Object.freeze(guardSecretBackendTransport(transport));
  return fenceSecretBackend(
    new NativeBrowserBackend(captured, clientFactory),
    captured,
  );
}
