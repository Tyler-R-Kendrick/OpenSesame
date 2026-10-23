import type {
  NativeConfiguration,
  NativeRequest,
  NativeResponse,
  NativeStreamChunk,
  NativeStreamHead,
} from "./protocol.js";

export type NativeHTTPClient = {
  ready(): boolean;
  nativeHTTP(
    id: number,
    request: NativeRequest,
    signal: AbortSignal,
  ): Promise<NativeResponse>;
  nativeHTTPStream?(
    id: number,
    request: NativeRequest,
    signal: AbortSignal,
  ): Promise<NativeStreamHead>;
  pullHTTP?(id: number, sequence: number): Promise<NativeStreamChunk>;
  cancelHTTP(id: number): boolean;
  closeHTTP(): boolean;
};
export type BrowserNodeAssets = {
  runtime: string;
  wasm: string;
  nativeHTTP?: string;
};
type NativeToken = Readonly<{ id: number }>;
type NativePublisher = (
  token: NativeToken,
  id: number,
  value: NativeResponse | null,
  code: string,
) => boolean;
type NativeStreamPublisher = (
  token: NativeToken,
  id: number,
  value: NativeStreamHead | NativeStreamChunk | null,
  code: string,
) => boolean;
type NativeRawPort = {
  begin(
    id: number,
    request: NativeRequest,
    token: NativeToken,
    publish: NativePublisher,
  ): string;
  beginStream?(
    id: number,
    request: NativeRequest,
    token: NativeToken,
    publish: NativeStreamPublisher,
  ): string;
  pull?(id: number, sequence: number, token: NativeToken): string;
  current(id: number): boolean;
  cancel(id: number): boolean;
  close(): void;
};
type NativeBridge = {
  bindNativeHTTP(
    raw: NativeRawPort,
    owner: { generation: object; signal: AbortSignal; current(): boolean },
  ): {
    nativeHTTP(
      id: number,
      request: NativeRequest,
      owner: { generation: object; signal: AbortSignal; current(): boolean },
    ): Promise<NativeResponse>;
    nativeHTTPStream(
      id: number,
      request: NativeRequest,
      owner: { generation: object; signal: AbortSignal; current(): boolean },
    ): Promise<NativeStreamHead>;
    pullHTTP(id: number, sequence: number): Promise<NativeStreamChunk>;
    cancelHTTP(id: number): boolean;
    closeHTTP(): boolean;
  };
};

/** Official @tailscale/connect's public WASM surface; no terminal UI dependency. */
export type BrowserNodeConfiguration = {
  hostname: string;
  controlURL: string;
  authKey: string;
  nativeHTTP?: NativeConfiguration;
  stateStorage: {
    getState(id: string): string;
    setState(id: string, value: string): void;
  };
};
export type BrowserNodeClient = {
  readonly nativeHTTPPort?: NativeRawPort;
  readonly nativeHTTPReady?: () => boolean;
  nativeHTTP?: NativeHTTPClient;
  run(callbacks: {
    notifyState(state: string): void;
    notifyNetMap(value: string): void;
    notifyBrowseToURL(url: string): void;
    notifyPanicRecover(error: string): void;
  }): void;
  login(): void;
  logout(): void;
  fetch(url: string): Promise<{
    status: number;
    statusText: string;
    text(): Promise<string>;
    /** Final response URL, when the SDK exposes the native Response. */
    url?: string;
    redirected?: boolean;
  }>;
};
declare const fs: { writeSync(fd: number, bytes: Uint8Array): number };
declare const Go: new () => {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
};
declare function newIPN(config: BrowserNodeConfiguration): BrowserNodeClient;
/** Call in a dedicated Worker after installing its private egress gate. */
export async function loadBrowserNode(
  config: BrowserNodeConfiguration,
  assets: BrowserNodeAssets,
  panic: () => void,
): Promise<BrowserNodeClient> {
  const ownedAssets = [assets.runtime, assets.wasm];
  if (assets.nativeHTTP) ownedAssets.push(assets.nativeHTTP);
  for (const href of ownedAssets) {
    const url = new URL(href);
    if (url.origin !== globalThis.location.origin || url.search || url.hash)
      throw new Error(
        "Tailscale runtime assets must belong to this deployment.",
      );
  }
  const compressed = await fetch(assets.wasm);
  if (!compressed.ok || !compressed.body)
    throw new Error("Tailscale browser client is unavailable offline.");
  const bytes = await new Response(
    compressed.body.pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer();
  // The runtime import is an owned, hash-pinned deployment asset, never a CDN.
  await import(/* @vite-ignore */ assets.runtime);
  // This executes only in the isolated worker, never in the app document.
  Object.defineProperty(fs, "writeSync", {
    value: (_fd: number, buffer: Uint8Array) => buffer.length,
  });
  const go = new Go();
  const wasm = await WebAssembly.instantiate(bytes, go.importObject);
  void go.run(wasm.instance).then(panic, panic);
  const node = newIPN(config);
  if (config.nativeHTTP) {
    if (!assets.nativeHTTP)
      throw new Error("Native HTTPS asset is unavailable.");
    node.nativeHTTP = await nativeBinding(node, assets.nativeHTTP);
  }
  return node;
}

/** Only the owned compiled node supplies raw callbacks and original readiness. */
async function nativeBinding(
  node: BrowserNodeClient,
  asset: string,
): Promise<NativeHTTPClient> {
  const raw = node.nativeHTTPPort;
  const ready = node.nativeHTTPReady;
  if (!raw || !ready) throw new Error("Native HTTPS node is unavailable.");
  const module: NativeBridge = await import(/* @vite-ignore */ asset);
  const generation = Object.freeze({});
  const owner = new AbortController();
  const current = () => !owner.signal.aborted && ready();
  const binding = module.bindNativeHTTP(raw, {
    generation,
    signal: owner.signal,
    current,
  });
  let closed = false;
  let acknowledged = false;
  const requester: NativeHTTPClient = {
    ready: current,
    nativeHTTP(id, request, signal) {
      return binding.nativeHTTP(id, request, {
        generation,
        signal,
        current: () => current() && !signal.aborted,
      });
    },
    nativeHTTPStream(id, request, signal) {
      return binding.nativeHTTPStream(id, request, {
        generation,
        signal,
        current: () => current() && !signal.aborted,
      });
    },
    pullHTTP: binding.pullHTTP,
    cancelHTTP: binding.cancelHTTP,
    closeHTTP() {
      if (closed) return acknowledged;
      closed = true;
      acknowledged = binding.closeHTTP();
      owner.abort();
      return acknowledged;
    },
  };
  return Object.freeze(requester);
}
