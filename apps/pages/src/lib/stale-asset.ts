/**
 * A lazy chunk this page named is gone. Reload once, then say so.
 *
 * The listener stays in the entry. The controller that saves a draft and
 * reloads is loaded when the failure happens; if that chunk is the one that
 * 404'd, the same session shot reloads without it.
 */

import {
  STALE_BUILD,
  isChunkLoadFailure,
} from "@opensesame/app-core/lib/chunk-load.js";
import { staleAssetReload } from "@opensesame/app-core/lib/stale-asset-reload.js";

let pending: Promise<boolean> | null = null;

async function showStaleNotice(): Promise<void> {
  try {
    const [{ setStatusNotice }, { workerControllerSeams }] = await Promise.all([
      import("@opensesame/app-core/lib/notices.js"),
      import("@opensesame/app-core/lib/capabilities/worker-controller.js"),
    ]);
    setStatusNotice({
      id: "shell:stale-asset",
      tone: "err",
      title: "Out of date",
      body: STALE_BUILD,
      retry: () => workerControllerSeams.reload(),
      retryLabel: "Reload",
    });
  } catch {
    // The shell is not up. The entry paints the same sentence.
  }
}

async function fallbackReload(): Promise<boolean> {
  if (staleAssetReload.already()) return false;
  staleAssetReload.mark();
  try {
    const { anyDirtyEdit, hasDraftSaver, saveDirtyDrafts } = await import(
      "@opensesame/app-core/lib/dirty-edit.js"
    );
    if (anyDirtyEdit() && hasDraftSaver()) await saveDirtyDrafts();
  } catch {
    // The edit could not be written. The chunk is still gone.
  }
  location.reload();
  return true;
}

async function run(): Promise<boolean> {
  try {
    const { reloadForStaleAsset } = await import(
      "@opensesame/app-core/lib/capabilities/worker-controller.js"
    );
    const started = await reloadForStaleAsset();
    if (!started) await showStaleNotice();
    return started;
  } catch {
    const started = await fallbackReload();
    if (!started) await showStaleNotice();
    return started;
  }
}

/**
 * Reload once for a missing chunk. A second call in the same session, or a
 * second failure after the one-shot, returns false so the page can say so.
 */
export function recoverStaleAsset(): Promise<boolean> {
  if (pending) return pending;
  pending = run().finally(() => {
    pending = null;
  });
  return pending;
}

/** `vite:preloadError` and a chunk rejection, once per document. */
export function installStaleAssetReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    void recoverStaleAsset();
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (!isChunkLoadFailure(event.reason)) return;
    event.preventDefault();
    void recoverStaleAsset();
  });
}
