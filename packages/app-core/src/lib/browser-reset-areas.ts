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
import { atRestSettled } from "./at-rest/key.js";
import { edbKnownDatabaseNames } from "./encrypted-db/names.js";
import {
  APP_DATABASES,
  type WebStorageArea,
  ownsDatabase,
  ownsOriginFile,
  ownsServiceWorkerScope,
  ownsWebStorageKey,
} from "./storage-ownership.js";

/** How long a blocked database deletion is waited for before it is reported. */
const DELETE_WAIT_MS = 3000;

/** How long the network has to answer before the app shell is kept. */
const PROBE_WAIT_MS = 3000;

/**
 * Settle with `work`, or reject once `ms` have passed: a step the browser
 * never answers (a push service, a worker that will not unregister) must
 * not hold the reset, and every tab waiting on it, open-ended.
 */
export function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

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
 * The encrypted databases (ADR 0175) this device holds. Their names are
 * keyed hashes, so they are found two ways: listed, where the browser can
 * (`indexedDB.databases()` is missing before Firefox 126), and derived from
 * the device key for every logical name the app opens. The key is read only
 * if it has already loaded - a reset must not mint one - and before the
 * database that holds it is deleted.
 */
async function encryptedDatabaseNames(factory: IDBFactory): Promise<string[]> {
  const names = new Set<string>();
  try {
    for (const entry of (await factory.databases?.()) ?? []) {
      if (entry.name !== undefined && ownsDatabase(entry.name)) {
        names.add(entry.name);
      }
    }
  } catch {
    // An engine that refuses to list is handled by the derived names.
  }
  const key = atRestSettled();
  if (key?.durable) {
    for (const name of edbKnownDatabaseNames(key.key)) names.add(name);
  }
  return [...names].filter((name) => !APP_DATABASES.includes(name));
}

/**
 * The app's databases, by their known names. Deleting a database that does
 * not exist succeeds, so most need no listing: the encrypted ones, whose
 * names are hashes, are the exception (`encryptedDatabaseNames`).
 */
export async function clearDatabases(
  waitMs: number = DELETE_WAIT_MS,
): Promise<void> {
  const factory = maybeIndexedDatabases();
  if (!factory) return;
  const names = [...APP_DATABASES, ...(await encryptedDatabaseNames(factory))];
  throwIfRefused(
    "databases",
    await Promise.allSettled(
      names.map((name) => deleteDatabase(factory, name, waitMs)),
    ),
  );
}

function clearStore(
  store: WebStorage | undefined,
  area: WebStorageArea,
  msalClientIds: readonly string[],
): void {
  if (!store) return;
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && ownsWebStorageKey(key, area, msalClientIds)) {
      keys.push(key);
    }
  }
  for (const key of keys) store.removeItem(key);
}

/**
 * The app's Web Storage keys, in both stores — MSAL's among them only where
 * they name one of `msalClientIds`.
 */
export function clearWebStorage(msalClientIds: readonly string[] = []): void {
  clearStore(maybeLocalStore(), "local", msalClientIds);
  clearStore(maybeSessionStore(), "session", msalClientIds);
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
