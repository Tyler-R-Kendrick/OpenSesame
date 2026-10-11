/**
 * Keeps the tray honest about environments for as long as the capability's
 * lease holds (ADR 0192). It reads the open vault, so a lock clears the tray
 * (the shell does that) and the next unlock brings the notice back; it is a
 * background job, not a panel, so it exists whether or not anyone opens the
 * sheet.
 */

import {
  clearEnvironmentNotices,
  syncEnvironmentNotices,
} from "@opensesame/app-core/lib/vault/environments-notices.js";
import { schemaKeys } from "@opensesame/app-core/lib/vault/environments.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { environmentNames } from "@opensesame/vault-core";

export function startEnvironmentNotices(signal: AbortSignal): void {
  let seenItems: unknown;
  let seenEnvironments: unknown;
  const sync = () => {
    const state = vaultStore.getSnapshot();
    if (state.status !== "unlocked") {
      seenItems = undefined;
      seenEnvironments = undefined;
      return;
    }
    // Every emit of the store lands here; only these two can change the answer.
    if (state.items === seenItems && state.environments === seenEnvironments) {
      return;
    }
    seenItems = state.items;
    seenEnvironments = state.environments;
    syncEnvironmentNotices(
      environmentNames(state.environments),
      schemaKeys(state.items),
    );
  };
  const stop = vaultStore.subscribe(sync);
  const end = () => {
    stop();
    clearEnvironmentNotices();
  };
  if (signal.aborted) {
    end();
    return;
  }
  signal.addEventListener("abort", end, { once: true });
  sync();
}
