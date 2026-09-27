/**
 * Storage writes stop here once this browser is being reset.
 *
 * The tab that resets (`browser-reset.ts`) halts its own writes after the
 * last one it started has landed, and every other tab halts on hearing the
 * reset (`browser-reset-channel.ts`) before it reloads. A halted tab's
 * origin-file writes are refused (`kv.ts`, `travel/storage.ts`) and its Web
 * Storage writes do nothing (`ports.ts`), so nothing it holds in memory can
 * be written back into storage that was just emptied. The navigation that
 * follows starts a fresh document, which is never halted.
 */

let halted = false;

export function haltStorageWrites(): void {
  halted = true;
}

export function storageWritesHalted(): boolean {
  return halted;
}

/** The error a refused write rejects with. */
export function haltedWriteError(): Error {
  return new Error("storage is being reset in this browser");
}

/** Tests only: a fresh document is never halted. */
export function resumeStorageWritesForTest(): void {
  halted = false;
}
