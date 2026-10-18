/**
 * One automatic reload per tab session when a lazy chunk 404s.
 *
 * The old service worker can keep serving the index this page booted from, so
 * a reload that does not help must not run again. The shell clears the shot
 * once it has loaded, and a later miss may reload once more.
 */

const KEY = "os-stale-asset-reload";

/** This document's shot, for a host with no `sessionStorage`. */
let memory = false;

function stored(): boolean | null {
  const scope: { sessionStorage?: Storage } = globalThis;
  try {
    const storage = scope.sessionStorage;
    if (!storage) return null;
    return storage.getItem(KEY) === "1";
  } catch {
    return null;
  }
}

export const staleAssetReload = {
  /** A reload for a missing chunk already happened in this tab session. */
  already(): boolean {
    return memory || stored() === true;
  },
  mark(): void {
    memory = true;
    const scope: { sessionStorage?: Storage } = globalThis;
    try {
      scope.sessionStorage?.setItem(KEY, "1");
    } catch {
      // Private mode. The in-memory shot still stops a loop in this document.
    }
  },
  clear(): void {
    memory = false;
    const scope: { sessionStorage?: Storage } = globalThis;
    try {
      scope.sessionStorage?.removeItem(KEY);
    } catch {
      // The in-memory shot is already clear.
    }
  },
};
