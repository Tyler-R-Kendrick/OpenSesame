/** Real worker_threads/TLS test adapter at the existing SDK injection boundary; never Go enrollment evidence. */
import { once } from "node:events";
import { request } from "node:https";
import {
  MessagePort as NodeMessagePort,
  Worker,
  isMainThread,
  parentPort,
} from "node:worker_threads";
import type { IdentityWorker } from "./identity-browser-node.js";
import type {
  HostEvent,
  NativeRequest,
  NativeResponse,
  WorkerCommand,
} from "./protocol.js";
import type {
  BrowserNodeClient,
  BrowserNodeConfiguration,
  NativeHTTPClient,
} from "./sdk.js";

type Diagnostic = {
  fixture: string;
  noAuthKey?: boolean;
  emptyState?: boolean;
  localState?: boolean;
  id?: number;
};
export function threadWorker(bundle: string) {
  const raw = new Worker(bundle);
  const messages: unknown[] = [];
  const diagnostics: Diagnostic[] = [];
  const exit = once(raw, "exit");
  const facade: IdentityWorker = {
    onmessage: null,
    onerror: null,
    postMessage: (value, ports) => {
      const transferred = ports.map((port) => {
        if (!(port instanceof NodeMessagePort))
          throw new Error("Original Node message port is required");
        return port;
      });
      raw.postMessage({ ...value, channel: ports[0] }, transferred);
    },
    terminate: () => {
      void raw.terminate();
    },
  };
  raw.on("message", (data) => {
    if (data.fixture === "channel-message") {
      messages.push(data.message);
      return;
    }
    messages.push(data);
    if (data.fixture) diagnostics.push(data);
    else facade.onmessage?.(new MessageEvent("message", { data }));
  });
  raw.on("error", (error) =>
    facade.onerror?.(
      Object.assign(new Event("error"), {
        message: error.message,
        filename: bundle,
        lineno: 0,
        colno: 0,
        error,
      }),
    ),
  );
  return {
    raw,
    facade,
    messages,
    diagnostics,
    exit,
    send: (value: WorkerCommand) => raw.postMessage(value),
  };
}
function wire(
  config: BrowserNodeConfiguration,
  connections: Map<number, ReturnType<typeof request>>,
  post: (value: Diagnostic) => void,
): NativeHTTPClient {
  let ended = false;
  return {
    ready: () => !ended,
    nativeHTTP(id: number, value: NativeRequest, signal: AbortSignal) {
      return new Promise<NativeResponse>((resolve, reject) => {
        const route = config.nativeHTTP;
        if (
          !route ||
          route.trustMode !== "operator" ||
          !route.targets.some(
            (target) => target.origin === new URL(value.url).origin,
          )
        ) {
          reject(new Error("Original fixture route unavailable."));
          return;
        }
        const outgoing = request(
          value.url,
          {
            ca: route.operatorCAPEM,
            method: value.method,
            headers: ["Host", new URL(value.url).host, ...value.headers.flat()],
            signal,
            agent: false,
            rejectUnauthorized: true,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 4_194_304)
                outgoing.destroy(new Error("Fixture response bound exceeded."));
              else chunks.push(chunk);
            });
            response.once("error", reject);
            response.once("end", () => {
              const headers: [string, string][] = [];
              for (let i = 0; i < response.rawHeaders.length; i += 2)
                headers.push([
                  response.rawHeaders[i] ?? "",
                  response.rawHeaders[i + 1] ?? "",
                ]);
              resolve({
                status: response.statusCode ?? 500,
                statusText: response.statusMessage ?? "",
                url: value.url,
                headers,
                body: new Uint8Array(Buffer.concat(chunks)),
              });
            });
          },
        );
        connections.set(id, outgoing);
        outgoing.once("close", () => {
          connections.delete(id);
          post({ fixture: "wire-closed", id });
        });
        outgoing.once("error", reject);
        outgoing.end(value.body);
      });
    },
    cancelHTTP(id) {
      connections.get(id)?.destroy(new Error("Original caller ended."));
      return true;
    },
    closeHTTP() {
      ended = true;
      for (const active of connections.values()) active.destroy();
      return connections.size === 0;
    },
  };
}
async function workerRealm() {
  const port = parentPort;
  if (!port) throw new Error("Owned worker parent missing.");
  const post = (value: Diagnostic) => port.postMessage(value);
  // The imported production entry installs a browser listener; this adapter explicitly owns Node delivery instead.
  Object.defineProperty(globalThis, "addEventListener", {
    value: () => undefined,
    configurable: true,
  });
  Object.defineProperty(globalThis, "postMessage", {
    value: (value: HostEvent) => port.postMessage(value),
    configurable: true,
  });
  const { BrowserNodeWorker } = await import("./worker.js");
  let callbacks: Parameters<BrowserNodeClient["run"]>[0] | null = null;
  const connections = new Map<number, ReturnType<typeof request>>();
  const driver = new BrowserNodeWorker(
    (value) => {
      driver.channel?.postMessage(value);
      port.postMessage({ fixture: "channel-message", message: value });
    },
    {
      egress: () => undefined,
      load: async (config) => {
        const emptyState =
          config.stateStorage.getState("private-node-key") === "";
        config.stateStorage.setState(
          "private-node-key",
          "worker-private-generated-state",
        );
        post({
          fixture: "memory",
          noAuthKey: config.authKey === "",
          emptyState,
          localState:
            config.stateStorage.getState("private-node-key") ===
            "worker-private-generated-state",
        });
        return {
          nativeHTTP: wire(config, connections, post),
          run(value) {
            callbacks = value;
            value.notifyState("NeedsLogin");
          },
          login() {
            post({ fixture: "explicit-login" });
            callbacks?.notifyNetMap(
              JSON.stringify({
                self: {
                  machineKey: "mkey:original",
                  nodeKey: "nodekey:original",
                  machineStatus: "MachineAuthorized",
                  addresses: ["100.64.0.9"],
                },
                peers: [],
                lockedOut: false,
              }),
            );
            callbacks?.notifyState("Running");
          },
          logout() {},
          fetch: async () => {
            throw new Error(
              "Peer GET was not requested by this SDK boundary fixture.",
            );
          },
        };
      },
    },
  );
  port.on("message", (data) => {
    if (data.fixture === "replace-self")
      callbacks?.notifyNetMap(
        JSON.stringify({
          self: {
            machineKey: "mkey:replacement",
            nodeKey: "nodekey:replacement",
            machineStatus: "MachineAuthorized",
            addresses: ["100.64.0.10"],
          },
          peers: [],
          lockedOut: false,
        }),
      );
    else
      driver.receive(
        new MessageEvent("message", {
          data,
          ports: data.channel ? [data.channel] : [],
        }),
      );
  });
  post({ fixture: "boot" });
}
if (!isMainThread) await workerRealm();
