/**
 * The stores "Reset this browser" empties, one function each, every one
 * limited to what this app owns (`storage-ownership.ts`). The origin is
 * shared with other sites — in production, every GitHub Pages project site
 * of the account — so nothing here lists an area and removes all of it.
 * Each function throws when something it owns could not be removed.
 */

import {
  type WebStorage,
  maybeCacheStorage,
  maybeIndexedDatabases,
  maybeLocalStore,
  maybeSessionStore,
  originFiles,
  serviceWorkerContainer,
} from "../ports.js";
import {
  APP_DATABASES,
  type WebStorageArea,
  ownsOriginFile,
  ownsServiceWorkerScope,
  ownsWebStorageKey,
} from "./storage-ownership.js";

/** How long a blocked database deletion is waited for before it is reported. */
const DELETE_WAIT_MS = 3000;

/** How long the network has to answer before the app shell is kept. */
const PROBE_WAIT_MS = 3000;

function notFound(result: PromiseRejectedResult): boolean {
  const { reason } = result;
  return reason instanceof DOMException && reason.name === "NotFoundError";
}

/** Throw when any removal was refused; one already gone counts as removed. */
function throwIfRefused<T>(
  what: string,
  results: readonly PromiseSettledResult<T>[],
): void {
  const refused = results.filter(
    (result) => result.status === "rejected" && !notFound(result),
  );
  if (refused.length > 0) {
    throw new Error(`${refused.length} ${what} could not be removed`);
  }
}

/** The app's origin-private files: `opensesame-pages-*`, and nothing else. */
export async function clearOriginFiles(): Promise<void> {
  const open = originFiles();
  if (!open) return;
  const root = await open();
  const names: string[] = [];
  for await (const name of root.keys()) {
    if (ownsOriginFile(name)) names.push(name);
  }
  throwIfRefused(
    "origin files",
    await Promise.allSettled(
      names.map((name) => root.removeEntry(name, { recursive: true })),
    ),
  );
}

function deleteDatabase(
  factory: IDBFactory,
  name: string,
  waitMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    // Blocked means a connection elsewhere is still open. Other tabs close
    // theirs when they hear the reset and reload, and then this succeeds;
    // one that never does is reported rather than counted as removed.
    const timer = setTimeout(
      () => reject(new Error(`${name} is still open`)),
      waitMs,
    );
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error(`could not delete ${name}`));
    };
  });
}

/**
 * The app's databases, by their known names. Deleting a database that does
 * not exist succeeds, so there is no need to list the origin's databases —
 * which `indexedDB.databases()` cannot do before Firefox 126 anyway.
 */
export async function clearDatabases(
  waitMs: number = DELETE_WAIT_MS,
): Promise<void> {
  const factory = maybeIndexedDatabases();
  if (!factory) return;
  throwIfRefused(
    "databases",
    await Promise.allSettled(
      APP_DATABASES.map((name) => deleteDatabase(factory, name, waitMs)),
    ),
  );
}

function clearStore(store: WebStorage | undefined, area: WebStorageArea): void {
  if (!store) return;
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && ownsWebStorageKey(key, area)) keys.push(key);
  }
  for (const key of keys) store.removeItem(key);
}

/** The app's Web Storage keys, in both stores. */
export function clearWebStorage(): void {
  clearStore(maybeLocalStore(), "local");
  clearStore(maybeSessionStore(), "session");
}

/** The service worker's caches under this app's scope (PWA-04). */
export async function clearCaches(
  ownsCache: (name: string) => boolean,
): Promise<void> {
  const caches = maybeCacheStorage();
  if (!caches) return;
  const names = (await caches.keys()).filter(ownsCache);
  throwIfRefused(
    "caches",
    await Promise.allSettled(names.map((name) => caches.delete(name))),
  );
}

async function ownedRegistrations(
  scope: string,
): Promise<readonly ServiceWorkerRegistration[]> {
  const container = serviceWorkerContainer();
  if (!container) return [];
  const registrations = await container.getRegistrations();
  return registrations.filter((registration) =>
    ownsServiceWorkerScope(registration.scope, scope),
  );
}

/**
 * End the app worker's Web Push subscription, so the previous account's
 * notifications stop arriving even where the worker itself stays.
 */
export async function unsubscribePush(scope: string): Promise<void> {
  const registrations = await ownedRegistrations(scope);
  for (const registration of registrations) {
    const subscription = await registration.pushManager?.getSubscription();
    if (subscription && !(await subscription.unsubscribe())) {
      throw new Error("the push subscription would not end");
    }
  }
}

/** The app's own worker registration, by its scope. */
export async function unregisterServiceWorkers(scope: string): Promise<void> {
  const registrations = await ownedRegistrations(scope);
  throwIfRefused(
    "service workers",
    await Promise.allSettled(
      registrations.map((registration) => registration.unregister()),
    ),
  );
}

/**
 * Whether the network answers for the app's own address right now.
 * `navigator.onLine` says only that there is a link. A HEAD request is never
 * answered by the service worker, which serves GETs (`sw/fetch.ts`), and
 * `no-store` keeps the HTTP cache out of it.
 */
export async function networkAnswers(
  scope: string,
  waitMs: number = PROBE_WAIT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);
  try {
    const response = await fetch(scope, {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
