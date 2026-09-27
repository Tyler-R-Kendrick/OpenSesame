/**
 * Reset this browser: everything the app keeps on this origin, removed, so
 * the next load is a first visit. Mostly a testing and hand-over tool.
 *
 * Deleting a vault (`VaultStore.destroy`) removes one tomb and leaves the
 * device's other vaults, its sign-in, its settings and its offline shell.
 * This removes all of it. The session is signed out first, while the bearer
 * its revocation sends is still in memory; then every origin-private file,
 * IndexedDB database, Web Storage key, Cache API cache and service-worker
 * registration goes. Other tabs of this origin are told, so they reload
 * rather than write what they hold in memory back into an emptied origin.
 *
 * Offline, the app shell stays: the Cache API holds only the service
 * worker's release assets, never anything a person stored, and removing them
 * with no network would leave the reload that follows nothing to load. Those
 * two areas are reported as kept, and the next online reset removes them.
 *
 * Not forensic erasure: what the browser keeps beyond the app's reach (the
 * HttpOnly cookie the Identity API sets, the HTTP cache, a granted storage
 * persistence) stays, and ciphertext already pushed to a backup remote is
 * untouched. The caller navigates afterwards; nothing here reloads.
 */

import {
  type WebStorage,
  isOnline,
  maybeCacheStorage,
  maybeIndexedDatabases,
  maybeLocalStore,
  maybeSessionStore,
  originFiles,
  serviceWorkerContainer,
} from "../ports.js";
import { announceBrowserReset } from "./browser-reset-channel.js";
import { settleRevokes } from "./identity.js";
import { signOut } from "./session-exit.js";

export type BrowserResetArea =
  | "session"
  | "origin_files"
  | "databases"
  | "web_storage"
  | "caches"
  | "service_workers";

/**
 * What went, what could not be removed, and what was kept on purpose (the
 * app shell, offline). Every other area is attempted.
 */
export type BrowserResetReport = Readonly<{
  cleared: readonly BrowserResetArea[];
  failed: readonly BrowserResetArea[];
  kept: readonly BrowserResetArea[];
}>;

/** The app shell: code the reload needs, never anything a person stored. */
const SHELL: ReadonlySet<BrowserResetArea> = new Set([
  "caches",
  "service_workers",
]);

async function endSession(): Promise<void> {
  signOut();
  // Bounded by the Identity fetch timeout; a failed revoke is not an error
  // here — the cookie is the server's to expire.
  await settleRevokes();
}

async function clearOriginFiles(): Promise<void> {
  const open = originFiles();
  if (!open) return;
  const root = await open();
  const names: string[] = [];
  for await (const name of root.keys()) names.push(name);
  await Promise.all(
    names.map((name) => root.removeEntry(name, { recursive: true })),
  );
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    // A connection in this tab is still open: the deletion is queued and
    // completes when the navigation that follows closes it.
    request.onblocked = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error(`could not delete ${name}`));
  });
}

async function clearDatabases(): Promise<void> {
  const factory = maybeIndexedDatabases();
  if (!factory) return;
  const databases = await factory.databases();
  await Promise.all(
    databases.flatMap(({ name }) =>
      name ? [deleteDatabase(factory, name)] : [],
    ),
  );
}

function clearStore(store: WebStorage | undefined): void {
  if (!store) return;
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null) keys.push(key);
  }
  for (const key of keys) store.removeItem(key);
}

function clearWebStorage(): void {
  clearStore(maybeLocalStore());
  clearStore(maybeSessionStore());
}

async function clearCaches(): Promise<void> {
  const caches = maybeCacheStorage();
  if (!caches) return;
  const names = await caches.keys();
  await Promise.all(names.map((name) => caches.delete(name)));
}

async function unregisterServiceWorkers(): Promise<void> {
  const container = serviceWorkerContainer();
  if (!container) return;
  const registrations = await container.getRegistrations();
  await Promise.all(
    registrations.map((registration) => registration.unregister()),
  );
}

/**
 * In order: the session before storage (sign-out writes the outcome the
 * sign-in panel reads, and that write must not survive), and Web Storage
 * after the stores whose absence it would otherwise describe.
 */
const STEPS: readonly (readonly [
  BrowserResetArea,
  () => void | Promise<void>,
])[] = [
  ["session", endSession],
  ["origin_files", clearOriginFiles],
  ["databases", clearDatabases],
  ["web_storage", clearWebStorage],
  ["caches", clearCaches],
  ["service_workers", unregisterServiceWorkers],
];

/** Remove everything this app keeps in this browser. Never throws. */
export async function resetBrowser(): Promise<BrowserResetReport> {
  const cleared: BrowserResetArea[] = [];
  const failed: BrowserResetArea[] = [];
  const kept: BrowserResetArea[] = [];
  const online = isOnline();
  for (const [area, step] of STEPS) {
    if (!online && SHELL.has(area)) {
      kept.push(area);
      continue;
    }
    try {
      await step();
      cleared.push(area);
    } catch {
      failed.push(area);
    }
  }
  announceBrowserReset();
  return { cleared, failed, kept };
}
