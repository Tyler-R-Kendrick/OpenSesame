/** Official Go/WireGuard runs in this terminable, privately governed realm. */
import { WorkerMessage } from "./protocol.js";
import { type BrowserNodeClient, loadBrowserNode } from "./sdk.js";
import { installWorkerEgress } from "./worker-egress.js";
let client: BrowserNodeClient | null = null;
let sequence = 0;
let started = false;
const decisions = new Map<number, (value: boolean) => void>();
function decide(url: string, method: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      decisions.delete(id);
      resolve(false);
    }, 30_000);
    decisions.set(id, (allowed) => {
      clearTimeout(timer);
      resolve(allowed);
    });
    globalThis.postMessage({ kind: "decision", id, url, method });
  });
}
async function start(
  config: Parameters<typeof loadBrowserNode>[0],
  assets: { runtime: string; wasm: string },
): Promise<void> {
  installWorkerEgress(decide, Object.values(assets));
  client = await loadBrowserNode(config, assets, () =>
    globalThis.postMessage({ kind: "error" }),
  );
  client.run({
    notifyState: (state) => {
      globalThis.postMessage({ kind: "state", state });
      if (state === "NeedsLogin" && config.authKey)
        setTimeout(() => client?.login(), 0);
    },
    notifyNetMap: (value) => globalThis.postMessage({ kind: "netmap", value }),
    notifyBrowseToURL: (url) => globalThis.postMessage({ kind: "auth", url }),
    notifyPanicRecover: () => globalThis.postMessage({ kind: "error" }),
  });
}
globalThis.addEventListener("message", (event: MessageEvent) => {
  const parsed = WorkerMessage.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.kind === "decision") {
    decisions.get(message.id)?.(message.allowed);
    decisions.delete(message.id);
    return;
  }
  if (message.kind === "login") {
    client?.login();
    return;
  }
  if (message.kind === "get") {
    void client
      ?.fetch(message.url)
      .then(async (response) => {
        const text = await response.text();
        globalThis.postMessage({
          kind: "get",
          id: message.id,
          status: response.status,
          text,
        });
      })
      .catch(() => globalThis.postMessage({ kind: "error" }));
    return;
  }
  if (started) return;
  started = true;
  const state = message.config.state;
  const config = {
    ...message.config,
    stateStorage: {
      getState: (id: string) => state[id] ?? "",
      setState: (id: string, value: string) => {
        state[id] = value;
        globalThis.postMessage({ kind: "storage", state });
      },
    },
  };
  void start(config, message.config.assets).catch(() =>
    globalThis.postMessage({ kind: "error" }),
  );
});
