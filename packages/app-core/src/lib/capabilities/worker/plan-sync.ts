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
import { workerControllerSeams } from "./seams.js";
import { diagnose, publish, state } from "./state.js";
import {
  type CompositionSnapshotForWorker,
  type PageToWorkerMessage,
  TAKEOVER_WAIT_MS,
} from "./types.js";

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
  if (state.reloadStarted) return;
  state.reloadStarted = true;
  workerControllerSeams.reload();
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
 * controller that cannot be reached all reload.
 */
export function onControllerChange(): void {
  state.takeover?.cancel();
  state.takeover = null;
  state.helloPending = false;
  if (state.bootReleaseId === null || !askWorker()) {
    reloadOnce();
    return;
  }
  state.takeover = {
    cancel: workerControllerSeams.later(() => {
      state.takeover = null;
      reloadOnce();
    }, TAKEOVER_WAIT_MS),
  };
}

/** The answer to a takeover's question: stay, or reload for a new release. */
function settleTakeover(releaseId: string): void {
  state.takeover?.cancel();
  state.takeover = null;
  if (releaseId !== state.bootReleaseId) {
    reloadOnce();
    return;
  }
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
