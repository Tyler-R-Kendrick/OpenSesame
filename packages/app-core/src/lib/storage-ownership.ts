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
 * - Web Storage: the ports' `local` and `session` stores refuse, in a
 *   development build, a key this rule does not own — so a new key fails its
 *   first test rather than outlive every reset.
 */

/** The start of every origin-private file `kv.ts` writes. */
export const ORIGIN_FILE_PREFIX = "opensesame-pages-";

/** Provisional history accounts and sealed snapshots (`history-backup-idb.ts`). */
export const HISTORY_BACKUP_DATABASE = "opensesame-history-backups";

/** Every IndexedDB database the app opens. */
export const APP_DATABASES: readonly string[] = [HISTORY_BACKUP_DATABASE];

export type WebStorageArea = "local" | "session";

/** Every Web Storage key the app writes starts with one of these. */
const KEY_PREFIXES = ["opensesame:", "opensesame.", "opensesame-"] as const;

/** The join ceremony's records (`join/presented.ts`, `join/stash.ts`). */
const KEYS: ReadonlySet<string> = new Set([
  "join.presented.v1",
  "join.pending.v2",
  "join.invite.v1",
]);

/**
 * MSAL's cache, which `ambient-auth/entra.ts` configures into sessionStorage:
 * this tab's, so ours. MSAL in another site's localStorage is not.
 */
const SESSION_KEY_PREFIXES = ["msal."] as const;

export function ownsOriginFile(name: string): boolean {
  return name.startsWith(ORIGIN_FILE_PREFIX);
}

export function ownsDatabase(name: string): boolean {
  return APP_DATABASES.includes(name);
}

export function ownsWebStorageKey(key: string, area: WebStorageArea): boolean {
  if (KEYS.has(key)) return true;
  if (KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  return (
    area === "session" &&
    SESSION_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
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
