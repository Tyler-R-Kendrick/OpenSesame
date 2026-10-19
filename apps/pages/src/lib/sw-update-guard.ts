/**
 * A release that waited on an edit still lands.
 *
 * Lock and a hidden tab save a draft when one is registered, then reload.
 * A visible tab is left alone: reading is not idle. The vault's own idle
 * lock asks for the same draft before it drops the key.
 */

import {
  forceSessionReload,
  subscribeWorkerStatus,
  updateIsOwed,
  workerStatus,
} from "@opensesame/app-core/lib/capabilities/worker-controller.js";
import { saveDirtyDrafts } from "@opensesame/app-core/lib/dirty-edit.js";
import { subscribeNotices } from "@opensesame/app-core/lib/notices.js";
import { idleLockSeams } from "@opensesame/app-core/lib/vault/idle-lock.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useEffect, useSyncExternalStore } from "react";
import { useDirtyFormWatch } from "./dirty-forms.js";
import { syncShellUpdateNotice } from "./shell-update.js";

/** How long a hidden tab may hold a release before the reload lands. */
export const HIDDEN_UPDATE_MS = 30_000;

/**
 * Lock, writing a draft first when a release is waiting. Sync when nothing
 * is waiting, so a lock that is not about to reload stays what it was.
 */
export function lockAfterDraft(store: { lock: () => void }): void {
  if (!updateIsOwed()) {
    store.lock();
    return;
  }
  void saveDirtyDrafts().finally(() => store.lock());
}

function installSessionReload(): () => void {
  const previous = idleLockSeams.beforeLock;
  idleLockSeams.beforeLock = () => (updateIsOwed() ? saveDirtyDrafts() : null);
  const stopLock = vaultStore.onLock(() => {
    forceSessionReload("lock");
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const onVisibility = () => {
    clearTimer();
    if (document.visibilityState !== "hidden" || !updateIsOwed()) return;
    timer = setTimeout(() => {
      timer = null;
      if (document.visibilityState !== "hidden" || !updateIsOwed()) return;
      void saveDirtyDrafts().finally(() => forceSessionReload("idle"));
    }, HIDDEN_UPDATE_MS);
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    idleLockSeams.beforeLock = previous;
    stopLock();
    clearTimer();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

function useShellUpdateNotice(): void {
  const updateReady = useSyncExternalStore(
    subscribeWorkerStatus,
    () => workerStatus().updateReady,
    () => false,
  );
  useEffect(() => {
    syncShellUpdateNotice(updateReady);
  }, [updateReady]);
  // A restored tray row must not outlive the release that caused it.
  useEffect(() => {
    const dropStale = () => {
      if (!workerStatus().updateReady) syncShellUpdateNotice(false);
    };
    dropStale();
    return subscribeNotices(dropStale);
  }, []);
}

/**
 * Dirty forms, the waiting-release notice, and the lock / hidden-tab reload.
 * Call before any early return so the unlock screen is covered too.
 */
export function useSwUpdateHost(): void {
  useDirtyFormWatch();
  useShellUpdateNotice();
  useEffect(() => installSessionReload(), []);
}
