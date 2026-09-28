/**
 * What this app keeps in a browser, by name: the one ownership rule.
 *
 * Pages is served from `https://<account>.github.io/OpenSesame/`, and that
 * origin belongs to every GitHub Pages project site of the account. Origin
 * storage is not divided by path, so whatever the app writes lands beside
 * other sites' data, and whatever it removes it may only remove by name.
 * Resetting this browser (`browser-reset.ts`) removes exactly what this rule
 * owns and nothing else; the Cache API is owned by the service worker's
 * scope-prefixed names (`apps/pages/src/sw/cache-names.ts`, PWA-04), and a
 * service-worker registration by its scope.
 *
 * Every store is written through a name this module can recognise:
 *
 * - origin-private files: `kv.ts` names every file `opensesame-pages-*.json`,
 *   and travel (`travel/storage.ts`) moves only files that pass that shape;
 * - IndexedDB: opened only through `openOwnedDatabase` (`ports.ts`), which
 *   refuses a name not listed here;
 * - Web Storage: every write through the ports' `local` and `session`
 *   stores is recorded by the test hosts, and a test that writes a key this
 *   rule does not own fails (`test-host-storage-writes.ts`) — so a new key
 *   fails its first test rather than outlive every reset.
 */

import { msalKeyNamesClient } from "./storage-ownership-msal.js";

/** The start of every origin-private file `kv.ts` writes. */
export const ORIGIN_FILE_PREFIX = "opensesame-pages-";

/** Provisional history accounts and sealed snapshots (`history-backup-idb.ts`). */
export const HISTORY_BACKUP_DATABASE = "opensesame-history-backups";

/**
 * The device's at-rest key (`at-rest/idb-key-store.ts`, ADR 0149). Resetting
 * this browser deletes it with everything sealed under it.
 */
export const AT_REST_DATABASE = "opensesame-at-rest";

/** Every IndexedDB database the app opens. */
export const APP_DATABASES: readonly string[] = [
  HISTORY_BACKUP_DATABASE,
  AT_REST_DATABASE,
];

export type WebStorageArea = "local" | "session";

/**
 * The Web Storage keys the app writes, by prefix. Exact, not `opensesame:`
 * whole: that namespace is also the relying-party SDKs'
 * (`@opensesame/sdk-browser`'s `opensesame:session`, `opensesame:pkce`,
 * `opensesame:returnTo`; `@opensesame/static-auth`'s
 * `opensesame:static-auth:*`), and a relying party on this origin keeps its
 * own session under them.
 */
const KEY_PREFIXES = [
  // Settings, guest, wallet (`.<tomb>` suffixes), GitHub App, drafts,
  // connect subjects, duress fence, the claim stash.
  "opensesame.",
  "opensesame:federation:",
  "opensesame:ambient-auth:",
] as const;

/** Keys owned whole. */
const KEYS: ReadonlySet<string> = new Set([
  // The legacy org profile, migrated into the tomb on unlock (`orgs.ts`).
  "opensesame:org-profile",
  // The join ceremony's records (`join/presented.ts`, `join/stash.ts`).
  "join.presented.v1",
  "join.pending.v2",
  "join.invite.v1",
]);

export function ownsOriginFile(name: string): boolean {
  return name.startsWith(ORIGIN_FILE_PREFIX);
}

export function ownsDatabase(name: string): boolean {
  return APP_DATABASES.includes(name);
}

/**
 * Whether a Web Storage key is the app's. MSAL writes its cache straight to
 * sessionStorage (`ambient-auth/entra.ts`), and that store is shared by
 * every same-origin page this tab has shown, so an MSAL key is the app's
 * only when it names one of the app's own Entra client ids
 * (`msalKeyNamesClient`).
 */
export function ownsWebStorageKey(
  key: string,
  area: WebStorageArea,
  msalClientIds: readonly string[] = [],
): boolean {
  if (KEYS.has(key)) return true;
  if (KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  return (
    area === "session" &&
    msalClientIds.some((clientId) => msalKeyNamesClient(key, clientId))
  );
}

/**
 * A registration is ours when its scope is the app's own: the registration
 * the app makes (`capabilities/worker-controller.ts`) is scoped to BASE_URL.
 * Another project site's worker on this origin has another scope.
 */
export function ownsServiceWorkerScope(
  scope: string,
  appScope: string,
): boolean {
  return scope === appScope;
}
