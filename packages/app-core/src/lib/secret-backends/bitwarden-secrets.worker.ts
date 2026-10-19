import * as bindings from "@bitwarden/sdk-wasm/bitwarden_wasm_bg.js";
import wasmURL from "@bitwarden/sdk-wasm/bitwarden_wasm_bg.wasm?url";
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import artifact from "./bitwarden-wasm-artifact.json" with { type: "json" };
import type { BitwardenSdkSettings } from "./bitwarden-wasm-loader.js";
import type { BitwardenSdkClient } from "./bitwarden-wasm-loader.js";
import { createBitwardenWorkerFetch } from "./bitwarden-worker-fetch.js";
import {
  BitwardenCommandSchema,
  BitwardenWorkerRequestSchema,
  BitwardenWorkerResultSchema,
} from "./bitwarden-worker-protocol.js";
import { secretBackendUrl } from "./http.js";
import { SecretBackendError } from "./types.js";
import { createGzipWasmAssetFetch } from "./wasm-gzip-asset.js";

type BitwardenBrowserBindings = typeof bindings;
async function initialize(): Promise<BitwardenBrowserBindings> {
  // Load the maintained WASM and its glue, excluding the package's Node entry and JS fallback.
  const lifetime = new AbortController();
  const failure = () =>
    new SecretBackendError(
      "network",
      "The Bitwarden cryptography module could not be loaded.",
    );
  const fetchAsset = createGzipWasmAssetFetch(
    { url: wasmURL, ...artifact },
    lifetime.signal,
    () => lifetime.signal.throwIfAborted(),
    fetch,
    failure,
  );
  const response = await fetchAsset(wasmURL);
  const imports: WebAssembly.ModuleImports = {};
  for (const [name, value] of Object.entries(bindings)) {
    const callable = z.function().safeParse(value);
    if (callable.success) imports[name] = callable.data;
  }
  const module = await WebAssembly.instantiate(await response.arrayBuffer(), {
    "./bitwarden_wasm_bg.js": imports,
  });
  bindings.__wbg_set_wasm(module.instance.exports);
  return bindings;
}

async function createIsolatedBitwardenClient(
  settings: BitwardenSdkSettings,
): Promise<BitwardenSdkClient> {
  const bindings = await initialize();
  return new bindings.BitwardenClient(
    JSON.stringify(settings),
    bindings.LogLevel.Error,
  );
}

let client: BitwardenSdkClient | undefined;
let queue = Promise.resolve();
const network = createBitwardenWorkerFetch((message) =>
  self.postMessage(message),
);

self.onmessage = (event: MessageEvent<BoundaryValue>) => {
  if (network.receive(event.data)) return;
  queue = queue.then(async () => {
    const parsed = BitwardenWorkerRequestSchema.safeParse(event.data);
    if (!parsed.success) {
      self.postMessage({ id: -1, ok: false, result: "" });
      return;
    }
    const message = parsed.data;
    try {
      if (message.type === "initialize") {
        if (client) throw new Error("Already initialized");
        secretBackendUrl(message.settings.apiUrl);
        secretBackendUrl(message.settings.identityUrl);
        client = await createIsolatedBitwardenClient(message.settings);
        self.fetch = network.fetch;
        self.postMessage({ id: message.id, ok: true, result: "null" });
      } else if (message.type === "free") {
        network.close();
        client?.free();
        client = undefined;
        self.postMessage({ id: message.id, ok: true, result: "null" });
        self.close();
      } else {
        if (!client) throw new Error("Not initialized");
        const command: BoundaryValue = JSON.parse(message.command);
        const checked = BitwardenCommandSchema.parse(command);
        const result = BitwardenWorkerResultSchema.parse(
          await client.run_command(JSON.stringify(checked)),
        );
        self.postMessage({ id: message.id, ok: true, result });
      }
    } catch {
      self.postMessage({ id: message.id, ok: false, result: "" });
    }
  });
};
