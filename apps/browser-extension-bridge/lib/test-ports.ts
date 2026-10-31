/** In-memory ports for the bridge's tests: the browser's grants, registrations and storage, and a fetch that is whatever the test says. */
import type { BridgePorts, FetchInit } from "./ports.js";

export const EXTENSION_ID = "bridge-extension-id";

export type FakeFetch = (url: URL, init: FetchInit) => Promise<Response>;

export function fakePorts(fetcher?: FakeFetch) {
  const store = new Map<string, string>();
  const asks = new Map<string, string>();
  const hosts = new Set<string>();
  const origins = new Set<string>();
  const registered = new Map<string, string>();
  const sent: { url: URL; init: FetchInit }[] = [];
  const state = { badge: "" };
  const bare: string[] = [];
  const ports: BridgePorts = {
    store: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value);
      },
    },
    asks: {
      get: async (key) => asks.get(key),
      set: async (key, value) => {
        asks.set(key, value);
      },
    },
    extensionId: EXTENSION_ID,
    hasHost: async (host) => hosts.has(host),
    removeHost: async (host) => {
      hosts.delete(host);
    },
    heldHosts: async () => [...hosts],
    hasOrigin: async (origin) => origins.has(origin),
    removeOrigin: async (origin) => {
      origins.delete(origin);
    },
    registeredIds: async () => [...registered.keys()],
    register: async (id, origin) => {
      registered.set(id, origin);
    },
    unregister: async (id) => {
      registered.delete(id);
    },
    fetch: async (url, init) => {
      sent.push({ url, init });
      if (!fetcher) throw new Error("no fetch in this test");
      return fetcher(url, init);
    },
    setBadge: async (text) => {
      state.badge = text;
    },
    setBareHosts: async (hosts) => {
      bare.splice(0, bare.length, ...hosts);
    },
  };
  return { ports, store, asks, hosts, origins, registered, sent, state, bare };
}
