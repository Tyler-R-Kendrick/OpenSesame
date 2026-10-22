import type { BoundaryValue } from "@opensesame/os-domain";
import type { BitwardenKdfResourceLimits } from "./bitwarden-native-kdf.js";
import { createBitwardenNativeWorkerFetch } from "./bitwarden-native-worker-fetch.js";
import { createBitwardenNativeWorkerRuntime } from "./bitwarden-native-worker-runtime.js";

// Browser allocation/work policy. Server KDF parameters are validated, never reduced or substituted.
const limits: BitwardenKdfResourceLimits = {
  maxPbkdf2Iterations: 2_000_000,
  maxArgon2Iterations: 10,
  maxArgon2MemoryMiB: 256,
  maxArgon2Parallelism: 16,
};
if ("importScripts" in globalThis) {
  const owner = new AbortController();
  const network = createBitwardenNativeWorkerFetch(
    (message) => self.postMessage(message),
    owner.signal,
  );
  const runtime = createBitwardenNativeWorkerRuntime(
    {
      send: (reply) => self.postMessage(reply),
      close() {
        owner.abort();
        network.close();
        self.postMessage({ type: "native-worker-closed" });
        self.close();
      },
    },
    {
      fetch: network.fetch,
      signal: owner.signal,
      assertCurrent: () => owner.signal.throwIfAborted(),
    },
    limits,
  );
  self.onmessage = (event: MessageEvent<BoundaryValue>) => {
    if (event.origin !== "" && event.origin !== self.location.origin) return;
    if (!network.receive(event.data)) runtime.receive(event.data);
  };
  self.onmessageerror = () => {
    void runtime.dispose();
  };
}
