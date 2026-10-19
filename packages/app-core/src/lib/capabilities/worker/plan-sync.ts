/**
 * The page's half of the worker conversation (`src/sw/messages.ts` is the
 * other half).
 *
 * Two things go out: `WORKER_HELLO`, to learn which release is controlling
 * the page, and `PLAN_ASSETS`, the approved module ids. Module ids only —
 * never a URL, never a file, never a worker unit, and never at all unless the
 * installation's delivery selection asked for `selected-only` offline
 * caching. Five things come back, and everything else is ignored; the
 * worker's answers become the `offlineStatus` a settings surface reads.
 */

import type { EffectivePlan } from "@opensesame/capability-composition";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  anyDirtyEdit,
  hasDraftSaver,
  saveDirtyDrafts,
  subscribeDirtyEdit,
} from "../../dirty-edit.js";
import { staleAssetReload } from "../../stale-asset-reload.js";
import { workerControllerSeams } from "./seams.js";
import { diagnose, publish, state } from "./state.js";
import {
  type CompositionSnapshotForWorker,
  type PageToWorkerMessage,
  type ReloadCause,
  TAKEOVER_WAIT_MS,
} from "./types.js";

/** Lock, idle, and a missing chunk reload even while an edit is unsaved. */
function reloadDespiteEdit(cause: ReloadCause): boolean {
  return cause === "lock" || cause === "idle" || cause === "stale-chunk";
}

let stopDirtyWatch: (() => void) | null = null;

function ensureDirtyWatch(): void {
  if (stopDirtyWatch) return;
  stopDirtyWatch = subscribeDirtyEdit(() => {
    if (anyDirtyEdit() || state.reloadStarted || state.updateOwed === null) {
      return;
    }
    requestReload(state.updateOwed);
  });
}

function clearDeferredUpdate(): void {
  state.updateOwed = null;
  if (state.status.updateReady) publish({ updateReady: false });
}

/**
 * Navigate once. A dirty edit with a saver is written first; the navigation
 * waits for that attempt and still happens when the saver cannot finish.
 */
function finishReload(saveFirst: boolean): void {
  if (state.reloadStarted) return;
  state.reloadStarted = true;
  state.updateOwed = null;
  if (state.status.updateReady) publish({ updateReady: false });
  const go = () => workerControllerSeams.reload();
  if (saveFirst) {
    void saveDirtyDrafts().finally(go);
    return;
  }
  go();
}

/**
 * A release change wants a reload. An unsaved edit holds the automatic ones
 * and says so (`updateReady`). Lock, idle, and a stale chunk do not hold.
 */
export function requestReload(cause: ReloadCause): void {
  if (state.reloadStarted) return;
  if (anyDirtyEdit() && !reloadDespiteEdit(cause)) {
    state.updateOwed = cause;
    publish({ updateReady: true });
    ensureDirtyWatch();
    return;
  }
  finishReload(anyDirtyEdit() && hasDraftSaver());
}

/** The deferred release reload, if the page is still holding one. */
export function updateIsOwed(): boolean {
  return state.updateOwed !== null && !state.reloadStarted;
}

/**
 * Lock and idle apply a release that was waiting on an edit. A stale chunk
 * reloads even when no release change is waiting: the page cannot fetch what
 * it was built against.
 */
export function forceSessionReload(
  cause: "lock" | "idle" | "stale-chunk",
): void {
  if (cause !== "stale-chunk" && !updateIsOwed()) return;
  requestReload(cause);
}

/**
 * A lazy chunk 404'd. Persist an edit when one is registered, then reload
 * once. A second failure in the same session returns false so the page can
 * say so instead of reloading forever.
 */
export async function reloadForStaleAsset(): Promise<boolean> {
  if (staleAssetReload.already()) return false;
  staleAssetReload.mark();
  if (!state.reloadStarted && anyDirtyEdit() && hasDraftSaver()) {
    try {
      await saveDirtyDrafts();
    } catch {
      // The chunk is gone either way.
    }
  }
  requestReload("stale-chunk");
  return true;
}

/** The shell loaded. A later chunk failure may reload again. */
export function noteShellLoaded(): void {
  staleAssetReload.clear();
}

export function postToController(message: PageToWorkerMessage): boolean {
  const controller = state.container?.controller;
  if (!controller) return false;
  try {
    controller.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the controlling worker who it is, unless that is already out and
 * unanswered. Returns whether a question is now in flight.
 */
export function askWorker(): boolean {
  if (state.helloPending) return true;
  state.helloPending = postToController({ type: "WORKER_HELLO" });
  return state.helloPending;
}

/** Reload the page for a new release: once, as it always did. */
export function reloadOnce(): void {
  finishReload(false);
}

/**
 * A new worker took the page. Another release may have deleted assets the
 * shell this page was served by references, so a change of release reloads —
 * as it always did. A change of *variant* within the release this page runs
 * (Push notifications approved or removed, here or in another tab of the same
 * origin) strands nothing, and a reload would end whatever the person is in
 * the middle of — an unlocked vault included. So the new worker is asked which
 * release it is and the page reloads only when that is not the release it
 * booted under. A page that does not know its release (its first load, before
 * any worker controlled it), a worker that does not answer in time, and a
 * controller that cannot be reached all reload. An unsaved edit holds that
 * reload until the edit is gone, the vault locks, or the tab sits idle;
 * a chunk that fails to load does not wait.
 */
export function onControllerChange(): void {
  state.takeover?.cancel();
  state.takeover = null;
  state.helloPending = false;
  if (state.bootReleaseId === null || !askWorker()) {
    requestReload("controller-unknown");
    return;
  }
  state.takeover = {
    cancel: workerControllerSeams.later(() => {
      state.takeover = null;
      requestReload("takeover-timeout");
    }, TAKEOVER_WAIT_MS),
  };
}

/** The answer to a takeover's question: stay, or reload for a new release. */
function settleTakeover(releaseId: string): void {
  state.takeover?.cancel();
  state.takeover = null;
  if (releaseId !== state.bootReleaseId) {
    requestReload("release-mismatch");
    return;
  }
  // Same release: a timeout that already deferred has nothing to reload for.
  clearDeferredUpdate();
  // Same release, another worker: nothing is stale. Forget what the previous
  // worker was told, introduce the plan to this one, and re-read which variant
  // now holds the scope.
  state.lastPlanKey = null;
  state.postedPlan = null;
  state.afterTakeover?.();
}

/** Page-loadable module ids: a `<capability>/worker` unit is the variant's. */
function pageModuleIds(plan: EffectivePlan): string[] {
  return plan.approvedModules.filter((id) => !id.endsWith("/worker"));
}

/**
 * Bring the controlling worker up to date with the plan. A pending transition
 * silences it: the worker about to be replaced is not the one to tell.
 */
export function syncPlan(snapshot: CompositionSnapshotForWorker): void {
  const { plan, selection } = snapshot;
  if (!plan || state.status.transition) return;
  if (selection?.delivery.offlineCache !== "selected-only") {
    if (
      state.status.offlineStatus !== "online-only" ||
      state.status.savedModuleIds.length > 0
    )
      publish({ offlineStatus: "online-only", savedModuleIds: [] });
    return;
  }
  if (!state.container?.controller) return;
  if (!state.workerReleaseId) {
    askWorker();
    return;
  }
  const moduleIds = pageModuleIds(plan);
  const key = `${state.workerReleaseId}|${plan.identity.planDigest}|${moduleIds.join(",")}`;
  if (key === state.lastPlanKey) return;
  const posted = postToController({
    type: "PLAN_ASSETS",
    releaseId: state.workerReleaseId,
    planDigest: plan.identity.planDigest,
    moduleIds,
  });
  if (!posted) return;
  state.lastPlanKey = key;
  state.postedPlan = {
    releaseId: state.workerReleaseId,
    planDigest: plan.identity.planDigest,
    moduleIds,
  };
  publish({ offlineStatus: "saving" });
}

/** A `PLAN_REJECTED` whose reason says the controller changed under us. */
function onPlanRejected(reason: BoundaryValue): void {
  diagnose(`PLAN_REJECTED:${isString(reason) ? reason : "unknown"}`);
  publish({ offlineStatus: "online-only" });
  state.postedPlan = null;
  if (reason !== "release-mismatch") return;
  state.workerReleaseId = null;
  state.lastPlanKey = null;
  if (state.latest) syncPlan(state.latest);
}

function onWorkerInfo(releaseId: BoundaryValue): void {
  if (!isString(releaseId)) return;
  state.helloPending = false;
  state.workerReleaseId = releaseId;
  if (state.bootControlled && state.bootReleaseId === null)
    state.bootReleaseId = releaseId;
  // Another release keeps its own caches: nothing is known saved in them yet,
  // and a plan posted to the old one is not this one's to answer.
  if (releaseId !== state.status.releaseId) {
    state.postedPlan = null;
    publish({ releaseId, savedModuleIds: [] });
  } else publish({ releaseId });
  if (state.takeover) settleTakeover(releaseId);
  // A timeout may already have deferred. The late answer is the same release
  // this page booted under: a variant change, and there is nothing to reload.
  else if (
    state.updateOwed === "takeover-timeout" &&
    releaseId === state.bootReleaseId
  ) {
    clearDeferredUpdate();
  }
  if (state.latest) syncPlan(state.latest);
}

/**
 * The worker saved every file of the plan it names, all or nothing
 * (`src/sw/plan-assets.ts`), so that plan's modules are now saved. A
 * readiness for some other plan, or from a release no longer controlling the
 * page, says nothing about these modules.
 */
function onOfflineReady(
  releaseId: BoundaryValue,
  planDigest: BoundaryValue,
): void {
  const posted = state.postedPlan;
  if (
    !posted ||
    releaseId !== posted.releaseId ||
    releaseId !== state.workerReleaseId ||
    planDigest !== posted.planDigest
  ) {
    publish({ offlineStatus: "saved" });
    return;
  }
  const saved = new Set([...state.status.savedModuleIds, ...posted.moduleIds]);
  publish({ offlineStatus: "saved", savedModuleIds: [...saved].sort() });
}

export function onWorkerMessage(data: BoundaryValue): void {
  if (!isJsonObject(data) || !isString(data.type)) return;
  switch (data.type) {
    case "WORKER_INFO":
      onWorkerInfo(data.releaseId);
      break;
    case "OFFLINE_READY":
      onOfflineReady(data.releaseId, data.planDigest);
      break;
    case "OFFLINE_PARTIAL":
      publish({ offlineStatus: "partial" });
      break;
    case "OFFLINE_STORAGE_UNAVAILABLE":
      publish({ offlineStatus: "storage-unavailable" });
      break;
    case "PLAN_REJECTED":
      onPlanRejected(data.reason);
      break;
    default:
      break;
  }
}
