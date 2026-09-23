/**
 * One signal for "a settings file changed", so the Form and the file viewer
 * redraw from the file after either one writes it. The vault store already
 * emits for writes to the sealed body; a tomb file has no store to emit, so
 * the writer says so here.
 */
import { useSyncExternalStore } from "react";

let revision = 0;
const listeners = new Set<() => void>();

export function notifySettingsFilesChanged(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function useSettingsFilesRevision(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => revision,
    () => revision,
  );
}
