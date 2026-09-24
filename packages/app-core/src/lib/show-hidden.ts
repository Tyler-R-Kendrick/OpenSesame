import { maybeLocalStore } from "../ports.js";
/**
 * Whether the rail lists hidden entries — every settings directory's
 * `config.yaml` and the vault's `trash/`. A file manager's "show hidden
 * items": off by default, per device, and a view preference only. Hiding an
 * entry never closes its road: a hidden path still opens by link, by the
 * command bar and by its own keys.
 */
const KEY = "opensesame.rail.show-hidden.v1";

const listeners = new Set<() => void>();
/** The latest choice this document made, whether or not the store kept it. */
let memory: boolean | null = null;

export function loadShowHidden(): boolean {
  try {
    return maybeLocalStore()?.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function saveShowHidden(next: boolean): void {
  memory = next;
  try {
    if (next) maybeLocalStore()?.setItem(KEY, "true");
    else maybeLocalStore()?.removeItem(KEY);
  } catch {
    // A full or absent store keeps the choice for this document only.
  }
  for (const listener of listeners) listener();
}

/** The choice as of now, including one a failing store could not keep. */
export function showHiddenSnapshot(): boolean {
  return memory ?? loadShowHidden();
}

export function subscribeShowHidden(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
