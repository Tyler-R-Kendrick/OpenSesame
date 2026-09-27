/**
 * A fake browser origin for the reset's tests: every store holds the app's
 * own entries beside another site's, and each can be told to refuse.
 */

import { overlapCast } from "@opensesame/os-domain";
import { vi } from "vitest";
import type { BroadcastLike, Ports, WebStorage } from "../ports.js";

/** The app's scope in these tests, as its worker registration reports it. */
export const SCOPE = "https://pages.test/OpenSesame/";
/** Another project site on the same origin. */
export const FOREIGN_SCOPE = "https://pages.test/other-site/";

/** The worker's naming (`apps/pages/src/sw/cache-names.ts`), as the shell passes it. */
export const ownsCache = (name: string) =>
  name.startsWith("opensesame-pages:/OpenSesame/:");

/** No port at all: the reset has nothing to clear there. */
export const NO_PORTS: Partial<Ports> = {
  storage: {},
  originFiles: undefined,
  indexedDB: undefined,
  cacheStorage: undefined,
  serviceWorker: undefined,
  broadcast: undefined,
};

export function memoryStorage(
  ...entries: (readonly [string, string])[]
): WebStorage & { map: Map<string, string> } {
  const map = new Map(entries);
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

export function originRoot(names: string[]) {
  const files = new Set(names);
  return {
    files,
    async *keys() {
      yield* [...files];
    },
    removeEntry: vi.fn(async (name: string) => {
      files.delete(name);
    }),
  };
}

type DeleteRequest = {
  onsuccess?: () => void;
  onerror?: () => void;
  onblocked?: () => void;
  error: DOMException | null;
};

/** How a deletion answers: at once, never (blocked), or with an error. */
export type DeleteOutcome = "success" | "blocked" | "error";

export function databaseFactory(
  names: string[],
  outcome: DeleteOutcome = "success",
) {
  const live = new Set(names);
  const deleted: string[] = [];
  return {
    live,
    deleted,
    deleteDatabase(name: string): DeleteRequest {
      deleted.push(name);
      const request: DeleteRequest = { error: null };
      queueMicrotask(() => {
        if (outcome === "blocked") {
          request.onblocked?.();
          return;
        }
        if (outcome === "error") {
          request.error = new DOMException("refused", "UnknownError");
          request.onerror?.();
          return;
        }
        live.delete(name);
        request.onsuccess?.();
      });
      return request;
    },
  };
}

export function cacheStore(names: string[]) {
  const live = new Set(names);
  const port: CacheStorage = overlapCast({
    keys: async () => [...live],
    delete: async (name: string) => live.delete(name),
  });
  return { live, port };
}

/** A worker registration's push state. */
export type FakeRegistrationOptions = Readonly<{
  subscribed?: boolean;
  unsubscribeRefuses?: boolean;
}>;

export function registration(
  scope: string,
  options: FakeRegistrationOptions = {},
) {
  const unsubscribe = vi.fn(async () => {
    if (options.unsubscribeRefuses) throw new DOMException("no", "AbortError");
    return true;
  });
  const unregister = vi.fn(async () => true);
  const subscription = options.subscribed ? { unsubscribe } : null;
  return {
    unsubscribe,
    unregister,
    value: {
      scope,
      unregister,
      pushManager: { getSubscription: async () => subscription },
    },
  };
}

export function workerContainer(
  ...registrations: ReturnType<typeof registration>[]
): ServiceWorkerContainer {
  return overlapCast({
    getRegistrations: async () => registrations.map((entry) => entry.value),
  });
}

/** What a fake tab posts on the reset channel. */
type Posted = Readonly<{ kind: string; tab: string }> | string | null;

/** A same-origin channel; `onPost` sees every message as it is posted. */
export function broadcastHub(onPost: () => void = () => undefined) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: Posted[] = [];
  const open = (): BroadcastLike =>
    overlapCast({
      postMessage(data: Posted) {
        onPost();
        posted.push(data);
        const event: MessageEvent = overlapCast({ data });
        for (const listener of listeners) listener(event);
      },
      close() {},
      addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        listeners.add(listener);
      },
      removeEventListener(
        _type: string,
        listener: (event: MessageEvent) => void,
      ) {
        listeners.delete(listener);
      },
      onmessage: null,
    });
  return { open, posted, listeners };
}
