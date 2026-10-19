/** Official Go/WireGuard runs in this terminable, privately governed realm. */
import "./worker-csp.js";
import {
  type HostEvent,
  NativeHTTPResponse,
  type NativeRequest,
  WorkerMessage,
} from "./protocol.js";
import {
  type BrowserNodeAssets,
  type BrowserNodeClient,
  loadBrowserNode,
} from "./sdk.js";
import { installWorkerEgress } from "./worker-egress.js";
type WorkerDependencies = {
  load: typeof loadBrowserNode;
  egress: typeof installWorkerEgress;
};
/** One owned realm/client; injection substitutes only the existing SDK boundary in tests. */
export class BrowserNodeWorker {
  private client: BrowserNodeClient | null = null;
  private sequence = 0;
  private started = false;
  private nativeClosed = false;
  private nativeHigh = 0;
  private nativePending = new Map<number, AbortController>();
  private decisions = new Map<number, (value: boolean) => void>();
  constructor(
    private readonly post: (message: HostEvent) => void,
    private readonly dependencies: WorkerDependencies = {
      load: loadBrowserNode,
      egress: installWorkerEgress,
    },
  ) {}
  private cancelNative(id: number) {
    this.nativeHigh = Math.max(this.nativeHigh, id);
    const caller = this.nativePending.get(id);
    this.nativePending.delete(id);
    caller?.abort();
    this.client?.nativeHTTP?.cancelHTTP(id);
  }
  private closeNative() {
    this.nativeClosed = true;
    for (const [id, caller] of this.nativePending) {
      this.nativePending.delete(id);
      caller.abort();
    }
    return this.client?.nativeHTTP?.closeHTTP() ?? true;
  }
  private panic() {
    this.closeNative();
    this.post({ kind: "error" });
  }
  private nativeCurrent(id: number, caller: AbortController) {
    return (
      this.nativePending.get(id) === caller &&
      !caller.signal.aborted &&
      !this.nativeClosed
    );
  }
  private nativeFailure(id: number, caller: AbortController) {
    if (this.nativePending.get(id) !== caller) return;
    this.nativePending.delete(id);
    this.post({ kind: "nativeHTTPError", id });
  }
  private nativeRequest(id: number, request: NativeRequest) {
    if (id <= this.nativeHigh) {
      this.post({ kind: "nativeHTTPError", id });
      return;
    }
    this.nativeHigh = id;
    const port = this.client?.nativeHTTP;
    if (!port || this.nativeClosed || this.nativePending.size >= 4) {
      port?.cancelHTTP(id);
      this.post({ kind: "nativeHTTPError", id });
      return;
    }
    const ready = port.ready;
    const caller = new AbortController();
    const captured = { ...request, body: request.body.slice() };
    this.nativePending.set(id, caller);
    let operation: Promise<Awaited<ReturnType<typeof port.nativeHTTP>>>;
    try {
      operation = port.nativeHTTP(id, captured, caller.signal);
    } catch {
      this.nativePending.delete(id);
      this.post({ kind: "nativeHTTPError", id });
      return;
    }
    void operation
      .then((result) => {
        if (!this.nativeCurrent(id, caller)) return;
        const parsed = NativeHTTPResponse.safeParse(result);
        if (!parsed.success) {
          this.nativeFailure(id, caller);
          return;
        }
        const value = { ...parsed.data, body: parsed.data.body.slice() };
        const authorized =
          parsed.data.url === captured.url &&
          this.client?.nativeHTTP === port &&
          ready();
        // The synchronous Go guard can withdraw/cancel reentrantly. No callback
        // or await lies between this exact-entry fence and original publication.
        if (!this.nativeCurrent(id, caller)) return;
        if (!authorized) {
          this.nativeFailure(id, caller);
          return;
        }
        this.nativePending.delete(id);
        this.post({ kind: "nativeHTTP", id, result: value });
      })
      .catch(() => this.nativeFailure(id, caller));
  }

  private decide(url: string, method: string): Promise<boolean> {
    return new Promise((resolve) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.decisions.delete(id);
        resolve(false);
      }, 30000);
      this.decisions.set(id, (allowed) => {
        clearTimeout(timer);
        resolve(allowed);
      });
      this.post({ kind: "decision", id, url, method });
    });
  }
  private async start(
    config: Parameters<typeof loadBrowserNode>[0],
    assets: BrowserNodeAssets,
  ) {
    const ownedAssets = [assets.runtime, assets.wasm];
    if (assets.nativeHTTP) ownedAssets.push(assets.nativeHTTP);
    this.dependencies.egress(this.decide.bind(this), ownedAssets);
    const client = await this.dependencies.load(config, assets, () =>
      this.panic(),
    );
    this.client = client;
    if (this.nativeClosed) client.nativeHTTP?.closeHTTP();
    client.run({
      notifyState: (state) => {
        this.post({ kind: "state", state });
        if (state === "NeedsLogin" && config.authKey)
          setTimeout(() => client.login(), 0);
      },
      notifyNetMap: (value) => this.post({ kind: "netmap", value }),
      notifyBrowseToURL: (url) => this.post({ kind: "auth", url }),
      notifyPanicRecover: () => this.panic(),
    });
  }
  private get(id: number, url: string) {
    void this.client
      ?.fetch(url)
      .then(async (response) => {
        const text = await response.text();
        this.post({ kind: "get", id, status: response.status, text });
      })
      .catch(() => this.post({ kind: "error" }));
  }
  receive(event: MessageEvent) {
    const parsed = WorkerMessage.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.kind === "nativeHTTPReady") {
      this.post({
        kind: "nativeHTTPReady",
        ready: !this.nativeClosed && this.client?.nativeHTTP?.ready() === true,
      });
      return;
    }
    if (message.kind === "nativeHTTP") {
      this.nativeRequest(message.id, message.request);
      return;
    }
    if (message.kind === "cancelHTTP") {
      this.cancelNative(message.id);
      return;
    }
    if (message.kind === "closeHTTP") {
      this.post({ kind: "closeHTTP", closed: this.closeNative() });
      return;
    }
    if (message.kind === "decision") {
      this.decisions.get(message.id)?.(message.allowed);
      this.decisions.delete(message.id);
      return;
    }
    if (message.kind === "login") {
      this.client?.login();
      return;
    }
    if (message.kind === "get") {
      this.get(message.id, message.url);
      return;
    }
    if (this.started) return;
    this.started = true;
    const state = message.config.state;
    const config = {
      ...message.config,
      stateStorage: {
        getState: (id: string) => state[id] ?? "",
        setState: (id: string, value: string) => {
          state[id] = value;
          this.post({ kind: "storage", state });
        },
      },
    };
    void this.start(config, message.config.assets).catch(() => this.panic());
  }
}
const worker = new BrowserNodeWorker((message) =>
  globalThis.postMessage(message),
);
globalThis.addEventListener("message", (event: MessageEvent) =>
  worker.receive(event),
);
