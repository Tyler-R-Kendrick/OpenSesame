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
import { diagnose, publish, state } from "./state.js";
import type {
  CompositionSnapshotForWorker,
  PageToWorkerMessage,
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
    if (state.status.offlineStatus !== "online-only")
      publish({ offlineStatus: "online-only" });
    return;
  }
  if (!state.container?.controller) return;
  if (!state.workerReleaseId) {
    postToController({ type: "WORKER_HELLO" });
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
  publish({ offlineStatus: "saving" });
}

/** A `PLAN_REJECTED` whose reason says the controller changed under us. */
function onPlanRejected(reason: BoundaryValue): void {
  diagnose(`PLAN_REJECTED:${isString(reason) ? reason : "unknown"}`);
  publish({ offlineStatus: "online-only" });
  if (reason !== "release-mismatch") return;
  state.workerReleaseId = null;
  state.lastPlanKey = null;
  if (state.latest) syncPlan(state.latest);
}

function onWorkerInfo(releaseId: BoundaryValue): void {
  if (!isString(releaseId)) return;
  state.workerReleaseId = releaseId;
  publish({ releaseId });
  if (state.latest) syncPlan(state.latest);
}

export function onWorkerMessage(data: BoundaryValue): void {
  if (!isJsonObject(data) || !isString(data.type)) return;
  switch (data.type) {
    case "WORKER_INFO":
      onWorkerInfo(data.releaseId);
      break;
    case "OFFLINE_READY":
      publish({ offlineStatus: "saved" });
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
