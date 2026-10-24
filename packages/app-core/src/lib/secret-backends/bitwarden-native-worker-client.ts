import type { BoundaryValue } from "@opensesame/os-domain";
import { workerConstructor } from "../../ports.js";
import { createBitwardenNativeNetworkBroker } from "./bitwarden-native-network-broker.js";
import type { NativeFetchReply } from "./bitwarden-native-network-protocol.js";
import {
  NativeWorkerClosed,
  NativeWorkerReply,
  NativeWorkerRequest,
  NativeWorkerSettings,
  type NativeWorkerValue,
} from "./bitwarden-native-worker-protocol.js";
import {
  type SecretBackendTransport,
  guardSecretBackendTransport,
} from "./transport.js";
import { SecretBackendError } from "./types.js";

type Operation = {
  [Kind in NativeWorkerRequest["type"]]: Omit<
    Extract<NativeWorkerRequest, { type: Kind }>,
    "id"
  >;
}[NativeWorkerRequest["type"]];
export type NativeWorkerCommand = Exclude<
  Operation,
  { type: "initialize" | "dispose" }
>;
export type BitwardenNativeClient = {
  readonly closed: AbortSignal;
  invoke(command: NativeWorkerCommand): Promise<NativeWorkerValue>;
  dispose(): void;
};
type Pending = {
  resolve(value: NativeWorkerValue): void;
  reject(error: SecretBackendError): void;
  timer: ReturnType<typeof setTimeout>;
};
function ended(): SecretBackendError {
  return new SecretBackendError(
    "stale",
    "The isolated native account session ended. Connect again.",
  );
}
class NativeWorkerClient implements BitwardenNativeClient {
  private worker: Worker | undefined;
  private readonly terminal = new AbortController();
  private readonly pending = new Map<number, Pending>();
  private readonly broker;
  private sequence = 0;
  private initialized = false;
  readonly closed = this.terminal.signal;
  constructor(
    private readonly transport: SecretBackendTransport,
    settings: NativeWorkerSettings,
  ) {
    this.current();
    this.broker = createBitwardenNativeNetworkBroker(
      { send: this.postNetwork, fail: this.dispose },
      transport,
      settings,
    );
    try {
      const Worker = workerConstructor();
      this.worker = new Worker(
        new URL("./bitwarden-native.worker.ts", import.meta.url),
        { type: "module", name: "opensesame-bitwarden-native" },
      );
      this.worker.addEventListener("message", this.receive);
      this.worker.addEventListener("messageerror", this.dispose);
      this.worker.addEventListener("error", this.dispose);
      transport.signal.addEventListener("abort", this.dispose, { once: true });
      this.current();
    } catch {
      this.dispose();
      throw ended();
    }
  }
  private current(): void {
    if (this.closed.aborted || this.transport.signal.aborted) throw ended();
    this.transport.assertCurrent();
    if (this.closed.aborted || this.transport.signal.aborted) throw ended();
  }
  readonly dispose = (): void => {
    if (this.closed.aborted) return;
    this.transport.signal.removeEventListener("abort", this.dispose);
    this.broker?.close();
    const worker = this.worker;
    this.worker = undefined;
    worker?.removeEventListener("message", this.receive);
    worker?.removeEventListener("messageerror", this.dispose);
    worker?.removeEventListener("error", this.dispose);
    // Parent termination also interrupts synchronous KDF/WASM, independently of worker message handling.
    worker?.terminate();
    this.terminal.abort();
    for (const operation of this.pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(ended());
    }
    this.pending.clear();
  };
  private readonly postNetwork = (reply: NativeFetchReply): void => {
    try {
      this.current();
      if (!this.worker) throw ended();
      if (reply.ok) this.worker.postMessage(reply, [reply.body.buffer]);
      else this.worker.postMessage(reply);
    } catch {
      this.dispose();
    }
  };
  private readonly receive = (event: MessageEvent<BoundaryValue>): void => {
    try {
      this.current();
      if (this.broker.receive(event.data)) return;
      if (NativeWorkerClosed.safeParse(event.data).success) {
        this.dispose();
        return;
      }
      const parsed = NativeWorkerReply.safeParse(event.data);
      if (!parsed.success) throw ended();
      const reply = parsed.data;
      const operation = this.pending.get(reply.id);
      if (!operation) throw ended();
      this.pending.delete(reply.id);
      clearTimeout(operation.timer);
      if (reply.ok) operation.resolve(reply.value);
      else operation.reject(new SecretBackendError(reply.code, reply.message));
    } catch {
      this.dispose();
    }
  };
  private send(operation: Operation): Promise<NativeWorkerValue> {
    try {
      this.current();
      if (
        !this.worker ||
        this.pending.size >= 4 ||
        this.sequence === Number.MAX_SAFE_INTEGER
      )
        throw ended();
      const request = NativeWorkerRequest.parse({
        ...operation,
        id: ++this.sequence,
      });
      return new Promise<NativeWorkerValue>((resolve, reject) => {
        this.pending.set(request.id, {
          resolve,
          reject,
          timer: setTimeout(this.dispose, 60000),
        });
        try {
          this.current();
          this.worker?.postMessage(request);
        } catch {
          this.dispose();
        }
      });
    } catch {
      this.dispose();
      return Promise.reject(ended());
    }
  }
  async initialize(settings: NativeWorkerSettings): Promise<void> {
    try {
      await this.send({ type: "initialize", settings });
      this.current();
      this.initialized = true;
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      settings.masterPassword = "";
      settings.clientSecret = "";
    }
  }
  async invoke(command: NativeWorkerCommand): Promise<NativeWorkerValue> {
    if (!this.initialized) throw ended();
    const value = await this.send(command);
    this.current();
    return value;
  }
}
/** Credentials are cloned once into a disposable worker; the returned port holds no key or API token. */
export async function createBrowserBitwardenNativeClient(
  settings: NativeWorkerSettings,
  transport: SecretBackendTransport,
  signal?: AbortSignal,
): Promise<BitwardenNativeClient> {
  const parsed = NativeWorkerSettings.safeParse(settings);
  if (!parsed.success)
    throw new SecretBackendError(
      "configuration",
      "Check the native account configuration fields.",
    );
  try {
    const client = new NativeWorkerClient(
      Object.freeze(guardSecretBackendTransport(transport, undefined, signal)),
      parsed.data,
    );
    await client.initialize(parsed.data);
    return client;
  } catch (error) {
    if (error instanceof SecretBackendError) throw error;
    throw ended();
  } finally {
    parsed.data.masterPassword = "";
    parsed.data.clientSecret = "";
  }
}
