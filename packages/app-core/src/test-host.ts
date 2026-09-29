import { browserPorts } from "./browser/host.js";
import { type Host, type RuntimeEnv, composeHost } from "./host.js";
import type { AtRestKeyPort } from "./ports.js";
import { recordStorageWrite } from "./test-host-storage-writes.js";

export type TestHostOverrides = Readonly<
  Partial<Omit<Host, "env">> & { env?: Partial<RuntimeEnv> }
>;

/** One at-rest key per test process, at hand at once (ADR 0149). */
const testAtRestKey = crypto.getRandomValues(new Uint8Array(32));
export const testAtRestKeys: AtRestKeyPort = {
  loadSync: () => testAtRestKey,
  load: async () => testAtRestKey,
};

/**
 * A host for tests: a development build served from `/`, with the browser's
 * ports read live — so a jsdom suite, or one that stubs a global, sees what
 * it set up — unless the test names its own. Every Web Storage write is
 * recorded, and the test setup fails a test that wrote a key the app does
 * not own. Values are sealed under a key the host has at hand, so a test
 * reads its storage back through the ports, as the app does.
 */
export function createTestHost(overrides: TestHostOverrides = {}): Host {
  const { env, ...ports } = overrides;
  return composeHost(browserPorts(), {
    env: { BASE_URL: "/", DEV: true, ...env },
    recordStorageWrite,
    atRestKeys: testAtRestKeys,
    ...ports,
  });
}

/** Remove the installed host, for tests of the uninstalled state. */
export function clearHostForTest(): void {
  globalThis.__opensesameAppCoreHost = undefined;
}

/**
 * Node 25+ installs a `localStorage` getter that returns nothing unless
 * `--localstorage-file` is set. jsdom then leaves the global empty. Drop that
 * getter. In a document, install a memory store. A Node suite keeps storage
 * absent, which is what Node 22 CI has.
 */
function storageFromGetter(read: () => Storage | null): Storage | null {
  try {
    const value = read();
    if (value == null || value.getItem === undefined) return null;
    return value;
  } catch {
    return null;
  }
}

function dropBrokenWebStorage(name: "localStorage" | "sessionStorage"): void {
  const read = Object.getOwnPropertyDescriptor(globalThis, name)?.get;
  if (read === undefined || storageFromGetter(read) !== null) return;
  delete globalThis[name];
}

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear() {
      items.clear();
    },
    getItem(key: string) {
      return items.get(key) ?? null;
    },
    key(index: number) {
      return [...items.keys()][index] ?? null;
    },
    removeItem(key: string) {
      items.delete(key);
    },
    setItem(key: string, value: string) {
      items.set(key, String(value));
    },
  };
}

function repairWebStorage(name: "localStorage" | "sessionStorage"): void {
  dropBrokenWebStorage(name);
  if (globalThis.document === undefined) return;
  if (globalThis[name] != null) return;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: memoryStorage(),
  });
}

export function repairInertWebStorage(): void {
  repairWebStorage("localStorage");
  repairWebStorage("sessionStorage");
}
