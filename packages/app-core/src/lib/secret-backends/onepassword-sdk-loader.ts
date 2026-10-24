import type { BoundaryValue, JsonValue } from "@opensesame/os-domain";
import { env } from "../../host.js";
import { pageOrigin, workerConstructor } from "../../ports.js";
import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import { createOnePasswordWorkerHttp } from "./onepassword-worker-http.js";
import {
  ONEPASSWORD_HTTP_MAX_PENDING,
  type OnePasswordAssets,
  OnePasswordAssetsSchema,
  type OnePasswordCommand,
  OnePasswordCommandSchema,
  OnePasswordFetchMessageSchema,
  type OnePasswordFetchResult,
  type OnePasswordSettings,
  OnePasswordSettingsSchema,
  OnePasswordWorkerReplySchema,
  type OnePasswordWorkerRequest,
  onePasswordNetworkError,
} from "./onepassword-worker-protocol.js";
import type { SecretBackendTransport } from "./transport.js";

function assetDirectory(origin: string, base: string): URL {
  const target = new URL(base, `${origin}/`);
  const unsafeSegment = base.split("/").some((segment) => {
    const decoded = decodeURIComponent(segment);
    return (
      [".", ".."].includes(decoded) ||
      /[\\/?#\s]/u.test(decoded) ||
      [...decoded].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    );
  });
  if (
    !base ||
    !base.endsWith("/") ||
    base.startsWith("//") ||
    (base.includes(":") &&
      (!/^https?:\/\//u.test(base) || target.href !== base)) ||
    unsafeSegment ||
    target.origin !== origin ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error("Invalid asset directory");
  return target;
}

/** Resolve pinned resources from the host deployment, without starting the SDK. */
export function onePasswordBrowserAssets(): OnePasswordAssets {
  try {
    const origin = pageOrigin();
    const home = new URL(origin);
    if (home.origin !== origin || !["https:", "http:"].includes(home.protocol))
      throw new Error("Invalid page origin");
    const base = assetDirectory(origin, env().BASE_URL);
    return OnePasswordAssetsSchema.parse({
      origin,
      runtimeUrl: new URL(artifacts.assets.runtime, base).href,
      wasmUrl: new URL(artifacts.assets.wasm, base).href,
    });
  } catch {
    throw new Error(
      "The 1Password browser assets are not configured for this deployment.",
    );
  }
}

type Pending = {
  type: "initialize" | "invoke" | "dispose";
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type Operation =
  | Omit<Extract<OnePasswordWorkerRequest, { type: "initialize" }>, "id">
  | Omit<Extract<OnePasswordWorkerRequest, { type: "invoke" }>, "id">
  | { type: "dispose" };
export type OnePasswordSdkClient = {
  readonly closed: AbortSignal;
  invoke(command: OnePasswordCommand): Promise<JsonValue>;
  dispose(): Promise<void>;
};

class OnePasswordWorkerClient implements OnePasswordSdkClient {
  private worker: Worker | undefined;
  private readonly broker;
  private readonly terminal = new AbortController();
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private closing = false;
  private ended = false;
  private initialized = false;
  private disposal: Promise<void> | undefined;
  private finishDisposal: (() => void) | undefined;
  readonly closed = this.terminal.signal;

  constructor(
    private readonly transport: SecretBackendTransport,
    accountOrigin: string,
    private readonly signal?: AbortSignal,
  ) {
    this.current();
    this.broker = createOnePasswordWorkerHttp(
      accountOrigin,
      transport,
      20_000,
      () => {
        if (!this.closing) this.terminate();
      },
    );
    try {
      const Worker = workerConstructor();
      this.worker = new Worker(
        new URL("./onepassword-sdk.worker.ts", import.meta.url),
        {
          type: "module",
          name: "opensesame-onepassword",
        },
      );
      this.worker.addEventListener("message", this.receive);
      this.worker.addEventListener("error", this.terminate);
      this.worker.addEventListener("messageerror", this.terminate);
      transport.signal.addEventListener("abort", this.terminate, {
        once: true,
      });
      signal?.addEventListener("abort", this.terminate, { once: true });
      this.current();
    } catch {
      this.terminate();
      throw onePasswordNetworkError();
    }
  }
  private current(): void {
    if (this.ended) throw onePasswordNetworkError();
    this.signal?.throwIfAborted();
    this.transport.signal.throwIfAborted();
    this.transport.assertCurrent();
    this.signal?.throwIfAborted();
    this.transport.signal.throwIfAborted();
  }
  private rejectPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(onePasswordNetworkError());
    }
    this.pending.clear();
  }
  private terminate = (): void => {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    this.transport.signal.removeEventListener("abort", this.terminate);
    this.signal?.removeEventListener("abort", this.terminate);
    this.broker?.close();
    this.worker?.removeEventListener("message", this.receive);
    this.worker?.removeEventListener("error", this.terminate);
    this.worker?.removeEventListener("messageerror", this.terminate);
    this.worker?.terminate();
    this.rejectPending();
    this.terminal.abort();
    this.finishDisposal?.();
  };
  private post(
    message: OnePasswordWorkerRequest | OnePasswordFetchResult,
    disposing = false,
  ): boolean {
    try {
      this.current();
      if (!this.worker || (this.closing && !disposing))
        throw onePasswordNetworkError();
      this.worker.postMessage(message);
      return true;
    } catch {
      this.terminate();
      return false;
    }
  }
  private receive = (event: MessageEvent<BoundaryValue>): void => {
    if (this.ended) return;
    try {
      this.current();
    } catch {
      this.terminate();
      return;
    }
    const network = OnePasswordFetchMessageSchema.safeParse(event.data);
    if (network.success) {
      if (
        !this.closing &&
        !this.broker.receive(network.data, (reply) => {
          this.post(reply);
        })
      )
        this.terminate();
      return;
    }
    const parsed = OnePasswordWorkerReplySchema.safeParse(event.data);
    if (!parsed.success || parsed.data.type === "closed") {
      this.terminate();
      return;
    }
    const reply = parsed.data;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    const expected = {
      initialize: "initialized",
      invoke: "result",
      dispose: "disposed",
    } as const;
    if (reply.type !== "failed" && reply.type !== expected[pending.type]) {
      this.terminate();
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(reply.id);
    if (reply.type === "failed") pending.reject(onePasswordNetworkError());
    else pending.resolve(reply.type === "result" ? reply.result : null);
  };
  private send(operation: Operation, deadlineMs = 30_000): Promise<JsonValue> {
    try {
      this.current();
      if (
        this.sequence === Number.MAX_SAFE_INTEGER ||
        this.pending.size >= ONEPASSWORD_HTTP_MAX_PENDING
      )
        throw onePasswordNetworkError();
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(this.terminate, deadlineMs);
        this.pending.set(id, { type: operation.type, resolve, reject, timer });
        this.post({ ...operation, id }, operation.type === "dispose");
      });
    } catch {
      this.terminate();
      return Promise.reject(onePasswordNetworkError());
    }
  }
  async initialize(
    settings: OnePasswordSettings,
    assets: OnePasswordAssets,
  ): Promise<void> {
    try {
      const validated = OnePasswordAssetsSchema.parse(assets);
      if (validated.origin !== pageOrigin()) throw onePasswordNetworkError();
      await this.send({
        type: "initialize",
        settings: OnePasswordSettingsSchema.parse(settings),
        assets: validated,
      });
      this.current();
      if (this.closing) throw onePasswordNetworkError();
      this.initialized = true;
    } catch {
      this.terminate();
      throw onePasswordNetworkError();
    }
  }
  async invoke(command: OnePasswordCommand): Promise<JsonValue> {
    try {
      if (!this.initialized || this.closing) throw onePasswordNetworkError();
      const result = await this.send({
        type: "invoke",
        command: OnePasswordCommandSchema.parse(command),
      });
      this.current();
      if (this.closing) throw onePasswordNetworkError();
      return result;
    } catch {
      try {
        this.current();
      } catch {
        this.terminate();
      }
      throw onePasswordNetworkError();
    }
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (this.ended) return Promise.resolve();
    this.closing = true;
    this.disposal = new Promise((resolve) => {
      this.finishDisposal = resolve;
    });
    this.rejectPending();
    this.terminal.abort();
    this.broker.close();
    // This timer lives in the parent realm: blocking synchronous WASM release cannot suppress it.
    void this.send({ type: "dispose" }, 1000).then(
      this.terminate,
      this.terminate,
    );
    return this.disposal;
  }
}

/** Dedicated disposable realm; no SDK assets load until explicit initialization. */
export async function createBrowserOnePasswordClient(
  settings: OnePasswordSettings,
  assets: OnePasswordAssets,
  transport: SecretBackendTransport,
  signal?: AbortSignal,
): Promise<OnePasswordSdkClient> {
  try {
    const client = new OnePasswordWorkerClient(
      transport,
      settings.accountOrigin,
      signal,
    );
    await client.initialize(settings, assets);
    return client;
  } catch {
    throw onePasswordNetworkError();
  }
}
