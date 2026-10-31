import "./worker-csp.js";
import { type HostEvent, WorkerMessage } from "./protocol.js";
import {
  type BrowserNodeAssets,
  type BrowserNodeClient,
  loadBrowserNode,
} from "./sdk.js";
import { installWorkerEgress } from "./worker-egress.js";
import { WorkerNativeHTTP } from "./worker-native-http.js";
import { WorkerPeerGET } from "./worker-peer-get.js";
type WorkerDependencies = {
  load: typeof loadBrowserNode;
  egress: typeof installWorkerEgress;
};
type Command = ReturnType<typeof WorkerMessage.parse>;
type Decision = { url: string; method: string; settle(allowed: boolean): void };
/** One owned realm/client; injection substitutes only the existing SDK boundary in tests. */
export class BrowserNodeWorker {
  private client: BrowserNodeClient | null = null;
  private sequence = 0;
  private started = false;
  private loading: Promise<void> | null = null;
  private lateNativeClose = true;
  private readonly peer = new WorkerPeerGET(
    () => this.client,
    (message) => this.post(message),
  );
  private readonly native = new WorkerNativeHTTP(
    () => this.client?.nativeHTTP,
    (message) => this.post(message),
  );
  private decisions = new Map<number, Decision>();
  private port: MessagePort | null = null;
  /** The one port the original `start` transferred; every reply leaves on it. */
  get channel() {
    return this.port;
  }
  constructor(
    private readonly post: (message: HostEvent) => void,
    private readonly dependencies: WorkerDependencies = {
      load: loadBrowserNode,
      egress: installWorkerEgress,
    },
  ) {}
  private panic() {
    this.native.close();
    void this.peer.close();
    this.post({ kind: "error" });
  }

  private decide(url: string, method: string): Promise<boolean> {
    return new Promise((resolve) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.decisions.delete(id);
        resolve(false);
      }, 30000);
      this.decisions.set(id, {
        url,
        method,
        settle: (allowed) => {
          clearTimeout(timer);
          resolve(allowed);
        },
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
    if (this.native.closed)
      this.lateNativeClose = client.nativeHTTP?.closeHTTP() ?? true;
    if (this.peer.closed) return;
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
  /**
   * The Worker's own channel: anything holding the Worker object reaches it,
   * so it only starts the node, once, with exactly one transferred port.
   */
  receive(event: MessageEvent) {
    const parsed = WorkerMessage.safeParse(event.data);
    const [port] = event.ports;
    if (!parsed.success || parsed.data.kind !== "start") return;
    if (this.started || !port || event.ports.length !== 1) return;
    this.started = true;
    this.port = port;
    port.onmessage = (command) => this.command(command);
    const { state, ephemeral } = parsed.data.config;
    const config = {
      ...parsed.data.config,
      stateStorage: {
        getState: (id: string) => state[id] ?? "",
        setState: (id: string, value: string) => {
          state[id] = value;
          if (!ephemeral) this.post({ kind: "storage", state });
        },
      },
    };
    this.loading = this.start(config, parsed.data.config.assets);
    void this.loading.catch(() => this.panic());
  }
  /** The start port: only the page's controller holds its other end. */
  command(event: MessageEvent) {
    const parsed = WorkerMessage.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.kind === "closeHTTP") this.retire();
    else if (message.kind === "decision") this.settle(message);
    else if (message.kind === "login") this.client?.login();
    else if (message.kind === "get") this.peer.get(message.id, message.url);
    else this.native.receive(message);
  }
  private retire() {
    this.peer.withdraw();
    const nativeClosed = this.native.close();
    void (this.loading ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const peerClosed = await this.peer.close();
        this.post({
          kind: "closeHTTP",
          closed: nativeClosed && this.lateNativeClose && peerClosed,
        });
      });
  }
  private settle(answer: Extract<Command, { kind: "decision" }>) {
    const pending = this.decisions.get(answer.id);
    if (pending?.url !== answer.url || pending.method !== answer.method) return;
    this.decisions.delete(answer.id);
    pending.settle(answer.allowed);
  }
}
const worker: BrowserNodeWorker = new BrowserNodeWorker((message) =>
  worker.channel?.postMessage(message),
);
globalThis.addEventListener("message", (event: MessageEvent) => {
  if (event.origin !== "" && event.origin !== globalThis.location.origin)
    return;
  worker.receive(event);
});
