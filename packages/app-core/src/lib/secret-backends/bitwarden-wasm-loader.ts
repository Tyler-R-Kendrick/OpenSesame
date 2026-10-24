import type { BoundaryValue } from "@opensesame/os-domain";
import { workerConstructor } from "../../ports.js";
import { createBitwardenWorkerHttp } from "./bitwarden-worker-http.js";
import {
  BitwardenFetchRequestSchema,
  type BitwardenFetchResult,
  BitwardenWorkerReplySchema,
  type BitwardenWorkerRequest,
} from "./bitwarden-worker-protocol.js";
import { SecretBackendError, type SecretBackendFetch } from "./types.js";

export type BitwardenSdkClient = {
  run_command(command: string): Promise<BoundaryValue>;
  free(): void;
};
export type BitwardenSdkSettings = { apiUrl: string; identityUrl: string };
export type BitwardenSdkFactory = (
  settings: BitwardenSdkSettings,
) => Promise<BitwardenSdkClient>;
type Pending = {
  resolve(value: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type WorkerOperation =
  | Omit<Extract<BitwardenWorkerRequest, { type: "initialize" }>, "id">
  | Omit<Extract<BitwardenWorkerRequest, { type: "command" }>, "id">
  | { type: "free" };

class BitwardenWorkerSession implements BitwardenSdkClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  readonly #abort = new AbortController();
  readonly #forward: ReturnType<typeof createBitwardenWorkerHttp>;
  readonly #signal: AbortSignal | undefined;
  #sequence = 0;
  #closed = false;
  #failure: SecretBackendError | undefined;

  constructor(
    settings: BitwardenSdkSettings,
    fetcher: SecretBackendFetch,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    this.#signal = signal;
    this.#forward = createBitwardenWorkerHttp(
      settings,
      fetcher,
      signal
        ? AbortSignal.any([signal, this.#abort.signal])
        : this.#abort.signal,
    );
    const Worker = workerConstructor();
    this.#worker = new Worker(
      new URL("./bitwarden-secrets.worker.ts", import.meta.url),
      { type: "module", name: "opensesame-bitwarden" },
    );
    this.#worker.addEventListener("error", this.#terminate);
    this.#worker.addEventListener("messageerror", this.#terminate);
    this.#worker.addEventListener("message", this.#receive);
    signal?.addEventListener("abort", this.#terminate, { once: true });
    if (signal?.aborted) this.#terminate();
  }

  readonly #terminate = () => {
    this.#end(
      new SecretBackendError(
        "network",
        "The isolated Bitwarden session ended.",
      ),
    );
  };

  #end(error: SecretBackendError): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    this.#signal?.removeEventListener("abort", this.#terminate);
    this.#worker.removeEventListener("error", this.#terminate);
    this.#worker.removeEventListener("messageerror", this.#terminate);
    this.#worker.removeEventListener("message", this.#receive);
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const operation of pending) {
      clearTimeout(operation.timer);
      operation.reject(error);
    }
    this.#abort.abort();
    try {
      this.#worker.terminate();
    } catch {
      // All callers are already withdrawn even if the realm has already ended.
    }
  }

  #postNetwork(value: BitwardenFetchResult): void {
    if (this.#closed) return;
    try {
      this.#worker.postMessage(value);
    } catch {
      this.#terminate();
    }
  }

  readonly #receive = (event: MessageEvent<BoundaryValue>) => {
    if (this.#closed) return;
    const network = BitwardenFetchRequestSchema.safeParse(event.data);
    if (network.success) {
      void this.#forward(network.data).then(
        (result) => this.#postNetwork(result),
        () =>
          this.#postNetwork({
            type: "fetch-result",
            id: network.data.id,
            ok: false,
            status: 0,
            statusText: "",
            url: network.data.url,
            headers: [],
            body: new Uint8Array(),
          }),
      );
      return;
    }
    const parsed = BitwardenWorkerReplySchema.safeParse(event.data);
    if (!parsed.success) {
      this.#terminate();
      return;
    }
    const reply = parsed.data;
    const operation = this.#pending.get(reply.id);
    if (!operation) {
      this.#terminate();
      return;
    }
    this.#pending.delete(reply.id);
    clearTimeout(operation.timer);
    if (reply.ok) operation.resolve(reply.result);
    else
      operation.reject(
        new SecretBackendError(
          "response",
          "The isolated Bitwarden operation failed.",
        ),
      );
  };

  #send(operation: WorkerOperation): Promise<string> {
    if (this.#closed)
      return Promise.reject(
        this.#failure ??
          new SecretBackendError("authentication", "Connect Bitwarden again."),
      );
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#end(
          new SecretBackendError(
            "network",
            "The Bitwarden operation timed out.",
          ),
        );
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#worker.postMessage({ ...operation, id });
      } catch {
        this.#terminate();
      }
    });
  }

  async initialize(settings: BitwardenSdkSettings): Promise<void> {
    try {
      await this.#send({ type: "initialize", settings });
    } catch (error) {
      this.#end(
        error instanceof SecretBackendError
          ? error
          : new SecretBackendError(
              "network",
              "The isolated Bitwarden session ended.",
            ),
      );
      throw error;
    }
  }
  run_command(command: string): Promise<BoundaryValue> {
    return this.#send({ type: "command", command });
  }
  free(): void {
    if (this.#closed) return;
    this.#terminate();
  }
}

/** Each SDK owns a fresh worker realm, WASM memory and logger; disconnect releases the realm. */
export async function createBrowserBitwardenClient(
  settings: BitwardenSdkSettings,
  fetcher: SecretBackendFetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<BitwardenSdkClient> {
  const client = new BitwardenWorkerSession(settings, fetcher, signal);
  await client.initialize(settings);
  return client;
}
