/** Official @tailscale/connect's public WASM surface; no terminal UI dependency. */
export type BrowserNodeConfiguration = {
  hostname: string;
  controlURL: string;
  authKey: string;
  stateStorage: {
    getState(id: string): string;
    setState(id: string, value: string): void;
  };
};
export type BrowserNodeClient = {
  run(callbacks: {
    notifyState(state: string): void;
    notifyNetMap(value: string): void;
    notifyBrowseToURL(url: string): void;
    notifyPanicRecover(error: string): void;
  }): void;
  login(): void;
  logout(): void;
  fetch(
    url: string,
  ): Promise<{ status: number; statusText: string; text(): Promise<string> }>;
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
  assets: { runtime: string; wasm: string },
  panic: () => void,
): Promise<BrowserNodeClient> {
  for (const href of [assets.runtime, assets.wasm]) {
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
  return newIPN(config);
}
