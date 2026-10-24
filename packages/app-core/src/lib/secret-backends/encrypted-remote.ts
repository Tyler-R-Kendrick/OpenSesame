import {
  type EncryptedRemoteConfiguration,
  EncryptedRemoteConflictError,
  type EncryptedRemoteHistory,
  type EncryptedRemoteIdentity,
  type EncryptedRemoteStore,
  MAX_REMOTE_BYTES,
  checkedRemoteRevision,
  openRemoteStore,
  remoteConfiguration,
  remoteEncryptionKey,
  remoteItem,
  remoteStrongEtag,
  sealRemoteStore,
} from "./encrypted-remote-codec.js";
import type { EncryptedRemoteContinuity } from "./encrypted-remote-continuity.js";
/** Actual encrypted-object CRUD; conditional writes never overwrite a concurrent winner. */
import { SecretBackendHttpError } from "./http.js";
import { createSecretBackendSessions } from "./sessions.js";
import {
  type SecretBackendTransport,
  guardSecretBackendTransport,
} from "./transport.js";
import {
  type SecretBackend,
  type SecretBackendCapabilities,
  type SecretBackendConfiguration,
  SecretBackendError,
  type SecretBackendItemInput,
  type SecretBackendSession,
} from "./types.js";
export interface EncryptedRemoteBackend extends SecretBackend {
  createItem: NonNullable<SecretBackend["createItem"]>;
  updateItem: NonNullable<SecretBackend["updateItem"]>;
  deleteItem: NonNullable<SecretBackend["deleteItem"]>;
  authenticate(
    config: SecretBackendConfiguration | EncryptedRemoteConfiguration,
  ): Promise<SecretBackendSession>;
  /** Explicit creation only: authentication never initializes or overwrites missing data. */
  initialize(
    config: SecretBackendConfiguration | EncryptedRemoteConfiguration,
  ): Promise<SecretBackendSession>;
}
type Context = EncryptedRemoteHistory & {
  configuration: EncryptedRemoteIdentity & { readonly bearerToken?: string };
  key: CryptoKey;
  signal: AbortSignal;
};
type Snapshot = { store: EncryptedRemoteStore; etag: string; envelope: string };
function conflict(): EncryptedRemoteConflictError {
  return new EncryptedRemoteConflictError();
}
function current(transport: SecretBackendTransport, held: Context): void {
  transport.assertCurrent();
  held.signal.throwIfAborted();
}
async function cancel(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}
async function body(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new SecretBackendError(
      "response",
      "The encrypted object response has no body.",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_REMOTE_BYTES)
        throw new SecretBackendError(
          "response",
          "The encrypted object exceeds the supported size.",
        );
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
async function responseStatus(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (response.ok && response.status !== 206) return;
  await cancel(response);
  if (response.status === 409 || response.status === 412) throw conflict();
  if (response.status === 401 || response.status === 403)
    throw await SecretBackendHttpError.fromResponse(
      response,
      "authentication",
      "The encrypted object endpoint refused these credentials.",
      signal,
    );
  if (response.status === 404)
    throw new SecretBackendError(
      "not-found",
      "The encrypted store does not exist. Create it explicitly before connecting.",
    );
  throw new SecretBackendError(
    "response",
    "The encrypted object request was refused.",
  );
}
class EncryptedObjectBackend implements EncryptedRemoteBackend {
  readonly id = "encrypted-remote";
  readonly name = "Encrypted Remote Store";
  readonly capabilities: SecretBackendCapabilities = {
    itemKinds: ["note", "login", "secret"],
    itemFields: ["username", "url", "notes", "secret"],
    vaultBackup: { kind: "note", field: "notes", maxBytes: 1024 * 1024 },
    list: true,
    get: true,
    create: true,
    update: true,
    delete: true,
    import: false,
  };
  readonly signal: AbortSignal;
  private readonly transport: SecretBackendTransport;
  private readonly sessions =
    createSecretBackendSessions<Context>("encrypted-remote");
  constructor(
    original: SecretBackendTransport,
    private readonly continuity?: EncryptedRemoteContinuity,
  ) {
    this.transport = guardSecretBackendTransport(original);
    this.signal = this.transport.signal;
  }
  private async request(
    held: Context,
    method: "GET" | "PUT",
    envelope?: string,
    match?: string,
  ) {
    current(this.transport, held);
    const signal = AbortSignal.any([
      held.signal,
      this.transport.signal,
      AbortSignal.timeout(20_000),
    ]);
    const headers = new Headers({ Accept: "application/json" });
    if (held.configuration.bearerToken)
      headers.set("Authorization", `Bearer ${held.configuration.bearerToken}`);
    if (method === "PUT") {
      headers.set("Content-Type", "application/json");
      headers.set(match === "*" ? "If-None-Match" : "If-Match", match ?? "");
    }
    const response = await this.transport.fetch(held.configuration.objectUrl, {
      method,
      headers,
      body: envelope,
      signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    current(this.transport, held);
    if (
      response.redirected ||
      (response.url && response.url !== held.configuration.objectUrl)
    ) {
      await cancel(response);
      throw new SecretBackendError(
        "configuration",
        "The encrypted object response must remain at its configured URL.",
      );
    }
    await responseStatus(response, signal);
    return { response, signal };
  }
  private async read(held: Context): Promise<Snapshot> {
    const { response, signal } = await this.request(held, "GET");
    let tag: string;
    try {
      tag = remoteStrongEtag(response.headers.get("etag"));
    } catch (error) {
      await cancel(response);
      throw error;
    }
    const envelope = await body(response, signal);
    current(this.transport, held);
    const store = await openRemoteStore(envelope, held.configuration, held.key);
    current(this.transport, held);
    await this.continuity?.observe(
      held.configuration,
      store.revision,
      envelope,
    );
    current(this.transport, held);
    checkedRemoteRevision(held, store, envelope);
    return { store, etag: tag, envelope };
  }
  private async connect(
    input: SecretBackendConfiguration | EncryptedRemoteConfiguration,
    initialize: boolean,
  ): Promise<SecretBackendSession> {
    this.transport.assertCurrent();
    const parsed = remoteConfiguration(
      "objectUrl" in input
        ? input
        : {
            objectUrl: input.baseUrl,
            storeId: input.remoteStoreId ?? "",
            encryptionKey: input.encryptionKey ?? "",
            bearerToken: input.token || undefined,
          },
    );
    const { encryptionKey, ...target } = parsed;
    const configuration = Object.freeze({
      ...target,
      objectUrl: new URL(target.objectUrl).href,
    });
    const key = await remoteEncryptionKey(encryptionKey);
    this.transport.assertCurrent();
    const held: Context = {
      configuration,
      key,
      signal: this.transport.signal,
      highest: 0,
    };
    if (initialize) {
      const envelope = await sealRemoteStore(
        { version: 1, storeId: configuration.storeId, revision: 1, items: [] },
        configuration,
        key,
      );
      const { response } = await this.request(held, "PUT", envelope, "*");
      await cancel(response);
    }
    await this.read(held);
    const session = this.sessions.create(held, this.transport.signal);
    if (!session.signal) {
      this.sessions.remove(session);
      throw new SecretBackendError(
        "authentication",
        "Reconnect the encrypted store.",
      );
    }
    held.signal = session.signal;
    return session;
  }
  private context(session: SecretBackendSession): Context {
    return this.sessions.read(session);
  }
  private async duringSession<T>(
    session: SecretBackendSession,
    operation: (held: Context) => Promise<T>,
  ): Promise<T> {
    const held = this.context(session);
    try {
      return await operation(held);
    } catch (error) {
      if (
        error instanceof SecretBackendError &&
        error.code === "authentication"
      )
        this.sessions.remove(session);
      throw error;
    }
  }
  private inspect(session: SecretBackendSession): Promise<Snapshot> {
    return this.duringSession(session, (held) => this.read(held));
  }
  private async mutate(
    session: SecretBackendSession,
    edit: (store: EncryptedRemoteStore) => void,
  ): Promise<void> {
    return this.duringSession(session, async (held) => {
      const snapshot = await this.read(held);
      edit(snapshot.store);
      snapshot.store.revision++;
      const envelope = await sealRemoteStore(
        snapshot.store,
        held.configuration,
        held.key,
      );
      current(this.transport, held);
      const { response } = await this.request(
        held,
        "PUT",
        envelope,
        snapshot.etag,
      );
      await cancel(response);
      current(this.transport, held);
      const verified = await this.read(held);
      if (verified.envelope !== envelope) throw conflict();
    });
  }
  private async find(name: string, session: SecretBackendSession) {
    const snapshot = await this.inspect(session);
    const item =
      snapshot.store.items.find((row) => row.id === name) ??
      snapshot.store.items.find((row) => row.name === name);
    if (!item)
      throw new SecretBackendError(
        "not-found",
        "The encrypted store item was not found.",
      );
    return item;
  }
  private item(input: SecretBackendItemInput, id: string) {
    return remoteItem({ ...input, id, kind: input.kind ?? "note" });
  }
  authenticate(
    config: SecretBackendConfiguration | EncryptedRemoteConfiguration,
  ) {
    return this.connect(config, false);
  }
  initialize(
    config: SecretBackendConfiguration | EncryptedRemoteConfiguration,
  ) {
    return this.connect(config, true);
  }
  getItem(name: string, session: SecretBackendSession) {
    return this.find(name, session);
  }
  async getNotes(name: string, session: SecretBackendSession) {
    return (await this.find(name, session)).notes;
  }
  async listItems(session: SecretBackendSession) {
    return (await this.inspect(session)).store.items.map(
      ({ id, name, kind }) => ({ id, name, kind }),
    );
  }
  async createItem(
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ) {
    const next = this.item(input, crypto.randomUUID());
    await this.mutate(session, (store) => {
      store.items.push(next);
    });
    return next;
  }
  async updateItem(
    id: string,
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ) {
    const next = this.item(input, id);
    await this.mutate(session, (store) => {
      const index = store.items.findIndex((row) => row.id === id);
      if (index < 0)
        throw new SecretBackendError(
          "not-found",
          "The encrypted store item was not found.",
        );
      store.items[index] = next;
    });
    return next;
  }
  async deleteItem(id: string, session: SecretBackendSession) {
    await this.mutate(session, (store) => {
      const index = store.items.findIndex((row) => row.id === id);
      if (index < 0)
        throw new SecretBackendError(
          "not-found",
          "The encrypted store item was not found.",
        );
      store.items.splice(index, 1);
    });
  }
  async disconnect(session: SecretBackendSession) {
    this.sessions.remove(session);
  }
}
export function createEncryptedRemoteBackend(
  transport: SecretBackendTransport,
  continuity?: EncryptedRemoteContinuity,
): EncryptedRemoteBackend {
  return new EncryptedObjectBackend(transport, continuity);
}

export { EncryptedRemoteConflictError } from "./encrypted-remote-codec.js";
