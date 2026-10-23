/** Official Go/WireGuard runs in this terminable, privately governed realm. */
import { isString } from "@opensesame/os-domain";
import "./worker-csp.js";
import { type HostEvent, WorkerMessage } from "./protocol.js";
import {
  type BrowserNodeAssets,
  type BrowserNodeClient,
  loadBrowserNode,
} from "./sdk.js";
import { installWorkerEgress } from "./worker-egress.js";
import { WorkerNativeHTTP } from "./worker-native-http.js";
type WorkerDependencies = {
  load: typeof loadBrowserNode;
  egress: typeof installWorkerEgress;
};
/** A peer GET is a plain HTTP(S) URL with no credential in its authority. */
function peerGetUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  return url;
}
/** The peer must not redirect the GET somewhere the controller did not approve. */
function unapprovedRedirect(
  response: Awaited<ReturnType<BrowserNodeClient["fetch"]>>,
  requested: URL,
): boolean {
  if (response.redirected === true) return true;
  if (!isString(response.url) || response.url === "") return false;
  try {
    return new URL(response.url).href !== requested.href;
  } catch {
    return true;
  }
}
/** One owned realm/client; injection substitutes only the existing SDK boundary in tests. */
export class BrowserNodeWorker {
  private client: BrowserNodeClient | null = null;
  private sequence = 0;
  private started = false;
  private readonly native = new WorkerNativeHTTP(
    () => this.client?.nativeHTTP,
    (message) => this.post(message),
  );
  private decisions = new Map<number, (value: boolean) => void>();
  constructor(
    private readonly post: (message: HostEvent) => void,
    private readonly dependencies: WorkerDependencies = {
      load: loadBrowserNode,
      egress: installWorkerEgress,
    },
  ) {}
  private panic() {
    this.native.close();
    this.post({ kind: "error" });
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
    if (this.native.closed) client.nativeHTTP?.closeHTTP();
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
  private get(id: number, rawUrl: string) {
    const url = peerGetUrl(rawUrl);
    if (!url) {
      this.post({ kind: "error" });
      return;
    }
    void this.client
      ?.fetch(url.href)
      .then(async (response) => {
        if (unapprovedRedirect(response, url))
          throw new Error("Tailscale peer redirected an approved GET.");
        const text = await response.text();
        this.post({ kind: "get", id, status: response.status, text });
      })
      .catch(() => this.post({ kind: "error" }));
  }
  receive(event: MessageEvent) {
    const parsed = WorkerMessage.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (this.native.receive(message)) return;
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
globalThis.addEventListener("message", (event: MessageEvent) => {
  if (event.origin !== "" && event.origin !== globalThis.location.origin)
    return;
  worker.receive(event);
});
