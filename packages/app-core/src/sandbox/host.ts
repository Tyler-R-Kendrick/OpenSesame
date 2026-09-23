/**
 * The sandbox host (ADR 0133 §6): what a bare JavaScript isolate — Android's
 * JavaScriptSandbox, or `vm.createContext` in CI — gives the core. Storage is
 * in memory and seeded by the embedder; there is no page, authenticator,
 * worker, lock or network signal. The runtime contract (crypto, URL,
 * TextEncoder, …) must already be installed; `installRuntimeContract` does
 * that for an isolate that has none.
 */
import type { Host, RuntimeEnv } from "../host.js";
import { createMemoryStorage } from "../memory-storage.js";

export type SandboxHostOptions = Readonly<{
  env?: Partial<RuntimeEnv>;
  /** Local storage entries the embedder hands in (for example a sealed tomb). */
  local?: Iterable<readonly [string, string]>;
}>;

export function createSandboxHost(options: SandboxHostOptions = {}): Host {
  return {
    env: { BASE_URL: "/", DEV: false, ...options.env },
    storage: {
      local: createMemoryStorage(options.local),
      session: createMemoryStorage(),
    },
  };
}
