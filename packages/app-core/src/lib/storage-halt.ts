/**
 * A tab stops here once this browser is being reset.
 *
 * Two steps, both one-way for the life of the document:
 *
 * - **resetting**: the reset has begun — in this tab, or another tab has said
 *   so. The shell stops drawing the app (`ResetGate`), so nothing on a screen
 *   whose memory describes storage that is going can be pressed.
 * - **halted**: writes stop. The tab that resets halts once the last write it
 *   started has landed; every other tab halts on hearing the reset
 *   (`browser-reset-channel.ts`). A halted tab's origin-file writes are
 *   refused (`kv.ts`, `travel/storage.ts`), its IndexedDB writes are skipped
 *   (`history-backup-idb.ts`) and its Web Storage writes do nothing
 *   (`ports.ts`), so nothing it holds can be written back into storage that
 *   was just emptied.
 *
 * Neither is ever lifted: the tab leaves for a fresh document, which starts
 * with neither.
 */

let resetting = false;
let halted = false;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** The reset has begun: stop offering the app. */
export function beginBrowserReset(): void {
  if (resetting) return;
  resetting = true;
  changed();
}

/** Stop every write. Implies the reset has begun. */
export function haltStorageWrites(): void {
  const before = resetting;
  halted = true;
  resetting = true;
  if (!before) changed();
}

export function browserResetting(): boolean {
  return resetting;
}

export function storageWritesHalted(): boolean {
  return halted;
}

/** Be told when the reset begins. */
export function onBrowserResetting(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The error a refused write rejects with. */
export function haltedWriteError(): Error {
  return new Error("storage is being reset in this browser");
}

/** Tests only: a fresh document is neither resetting nor halted. */
export function resumeStorageWritesForTest(): void {
  resetting = false;
  halted = false;
  changed();
}
