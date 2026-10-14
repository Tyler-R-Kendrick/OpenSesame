import type { BoundaryValue } from "@opensesame/os-domain";
import { workerConstructor } from "../../ports.js";
import { createBitwardenWorkerHttp } from "./bitwarden-worker-http.js";
import {
  BitwardenFetchRequestSchema,
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
  }

  readonly #terminate = () => {
    this.#closed = true;
    this.#signal?.removeEventListener("abort", this.#terminate);
    this.#abort.abort();
    this.#worker.terminate();
    for (const operation of this.#pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(
        new SecretBackendError(
          "network",
          "The isolated Bitwarden session ended.",
        ),
      );
    }
    this.#pending.clear();
  };

  readonly #receive = (event: MessageEvent<BoundaryValue>) => {
    const network = BitwardenFetchRequestSchema.safeParse(event.data);
    if (network.success) {
      void this.#forward(network.data).then(
        (result) => this.#worker.postMessage(result),
        () =>
          this.#worker.postMessage({
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
    if (!operation) return;
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
        new SecretBackendError("authentication", "Connect Bitwarden again."),
      );
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new SecretBackendError(
            "network",
            "The Bitwarden operation timed out.",
          ),
        );
        this.#terminate();
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#worker.postMessage({ ...operation, id });
    });
  }

  async initialize(settings: BitwardenSdkSettings): Promise<void> {
    try {
      await this.#send({ type: "initialize", settings });
    } catch (error) {
      this.#terminate();
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
