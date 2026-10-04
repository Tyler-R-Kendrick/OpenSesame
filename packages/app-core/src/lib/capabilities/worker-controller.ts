/**
 * Service-worker registration driven by the effective plan (ownership.md
 * §4.7; PWA-02, PWA-03, PWA-06).
 *
 * The plan names the worker variant an installation must run
 * (`requiredWorkerVariant`, `null` meaning core-only) and the distribution
 * says which script each variant is. This controller registers that script —
 * once per page, only when the plan is core-only or the installation has a
 * persisted selection and receipt covering the capability the variant serves
 * — and never registers a second, competing worker: a scope holds one script,
 * so when the registered script differs from the required one the controller
 * replaces it in place (`transitionWorker()`), on activation and whenever a
 * page boots with the plan already asking for it.
 *
 * Approving a capability whose variant this is IS the consent (the same
 * persisted selection and receipt `variantEligible` demands before a first
 * registration), so the move needs no second prompt. It is made safe, not
 * deferred: the old script is never unregistered (a registration with no
 * script would leave the person with no worker, and unregistering drops the
 * push subscription it holds), the new one installs beside it and takes over
 * only when ready, and the page it takes over is not reloaded — both variants
 * of one build serve the same shell. `transition-required` stays visible for
 * the moment between noticing the difference and acting on it.
 *
 * Once a worker controls the page the controller asks it who it is
 * (`WORKER_HELLO` → `WORKER_INFO`) and, when the selection asks for
 * `selected-only` offline delivery, posts the approved module ids as
 * `PLAN_ASSETS` (`worker/plan-sync.ts`). It never posts a URL. The worker's
 * answers become the `offlineStatus` a settings surface reads through
 * `useWorkerStatus` (`bindings/capabilities.ts`).
 *
 * The parts live under `worker/`: the platform seams, the page-level state
 * and its external store, the plan conversation, and the shared types.
 * Nothing here imports `virtual:pwa-register` or workbox-window: the
 * registration call is the platform's own.
 */

import { overlapCast } from "@opensesame/os-domain";
import { onWorkerMessage, syncPlan } from "./worker/plan-sync.js";
import { scriptUrlFor, workerControllerSeams } from "./worker/seams.js";
import {
  diagnose,
  publish,
  state,
  subscribeWorkerStatus,
} from "./worker/state.js";
import {
  CORE_ONLY_VARIANT,
  type CompositionSnapshotForWorker,
  type CompositionStoreForWorker,
  type RegisterWorkerOptions,
  VARIANT_CAPABILITY,
  WORKER_GRAPH_UNAVAILABLE,
} from "./worker/types.js";

export { CORE_ONLY_VARIANT, WORKER_GRAPH_UNAVAILABLE };
export { workerControllerSeams } from "./worker/seams.js";
export {
  resetWorkerController,
  subscribeWorkerStatus,
  workerStatus,
} from "./worker/state.js";
export type {
  CompositionSnapshotForWorker,
  CompositionStoreForWorker,
  OfflineStatus,
  PageToWorkerMessage,
  RegisterWorkerOptions,
  WorkerStatus,
  WorkerTransition,
} from "./worker/types.js";

/** Which variant a registered script is, by the distribution's table. */
function variantOfScript(scriptUrl: string): string | null {
  const variant = state.distribution?.workerVariants.find(
    (v) => scriptUrlFor(v.scriptPath) === scriptUrl,
  );
  return variant?.id ?? null;
}

/**
 * The script this scope is running or about to run: the newest worker first,
 * so a replacement still installing counts as the answer and is not asked for
 * a second time.
 */
function registeredScript(
  registration: ServiceWorkerRegistration | undefined,
): string | null {
  if (!registration) return null;
  return (
    registration.installing?.scriptURL ??
    registration.waiting?.scriptURL ??
    registration.active?.scriptURL ??
    null
  );
}

/**
 * Whether the installation may run this variant yet. Core-only always; any
 * other variant only once a persisted selection and receipt exist, and, for a
 * variant that serves one capability, only when that capability is approved
 * and named in the receipt (PWA-03).
 */
function variantEligible(
  id: string,
  snapshot: CompositionSnapshotForWorker,
): boolean {
  if (id === CORE_ONLY_VARIANT) return true;
  const { plan, selection, receipt } = snapshot;
  if (!plan || !selection || !receipt) return false;
  const capability = VARIANT_CAPABILITY.get(id);
  if (!capability) return true;
  return (
    plan.approvedCapabilities.includes(capability) &&
    capability in receipt.exposure
  );
}

async function register(
  container: ServiceWorkerContainer,
  scriptUrl: string,
): Promise<boolean> {
  state.registeredThisPage = true;
  try {
    await container.register(scriptUrl, {
      type: "classic",
      updateViaCache: "none",
      scope: workerControllerSeams.baseUrl(),
    });
    return true;
  } catch {
    diagnose("WORKER_REGISTRATION_FAILED");
    return false;
  }
}

function attachContainerListeners(container: ServiceWorkerContainer): void {
  if (state.listenersAttached) return;
  state.listenersAttached = true;
  container.addEventListener("message", (event) => {
    // SAFETY: a worker message's data is whatever the worker posted; the
    // handler narrows it field by field before reading anything.
    onWorkerMessage(overlapCast(event.data));
  });
  container.addEventListener("controllerchange", onControllerChange);
}

/**
 * A new worker took the page. Another release may have deleted assets the
 * shell it was served by references, so the page reloads — once, as it always
 * did. The exception is the move this page made itself between two variants
 * of the same build: nothing is stale, and a reload would end whatever the
 * person is in the middle of (an unlocked vault included). The page keeps
 * running and introduces itself to the worker that now controls it.
 */
function onControllerChange(): void {
  if (state.variantSwitch) {
    state.variantSwitch = false;
    state.workerReleaseId = null;
    state.lastPlanKey = null;
    state.postedPlan = null;
    if (state.latest) syncPlan(state.latest);
    return;
  }
  if (state.reloadStarted) return;
  state.reloadStarted = true;
  workerControllerSeams.reload();
}

async function currentRegistration(
  container: ServiceWorkerContainer,
): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await container.getRegistration(workerControllerSeams.baseUrl());
  } catch {
    return undefined;
  }
}

/**
 * Another variant holds this scope. Say so, then move: the variant is only
 * required here once it is eligible, which is the consent.
 */
async function enterTransition(
  registration: ServiceWorkerRegistration,
  current: string,
  requiredId: string,
  requiredUrl: string,
): Promise<void> {
  const from = variantOfScript(current);
  state.pendingTransition = {
    registration,
    scriptUrl: requiredUrl,
    to: requiredId,
  };
  publish({
    variant: from,
    transition: { from, to: requiredId, status: "transition-required" },
  });
  await transitionWorker();
}

async function ensureRegistered(
  container: ServiceWorkerContainer,
  current: string | null,
  requiredUrl: string,
): Promise<void> {
  if (current) return;
  if (state.registeredThisPage) return;
  if (workerControllerSeams.crossOriginIsolated()) return;
  await register(container, requiredUrl);
}

function publishVariant(current: string | null, requiredId: string): void {
  if (current) {
    publish({ variant: variantOfScript(current) });
    return;
  }
  publish({ variant: state.registeredThisPage ? requiredId : null });
}

async function reconcile(
  snapshot: CompositionSnapshotForWorker,
): Promise<void> {
  const { container, distribution } = state;
  const plan = snapshot.plan;
  if (!container || !distribution || !plan) return;
  const requiredId = plan.requiredWorkerVariant ?? CORE_ONLY_VARIANT;
  publish({ requiredVariant: requiredId });
  const variant = distribution.workerVariants.find((v) => v.id === requiredId);
  if (!variant) {
    diagnose(WORKER_GRAPH_UNAVAILABLE);
    return;
  }
  if (!variantEligible(requiredId, snapshot)) return;
  const requiredUrl = scriptUrlFor(variant.scriptPath);
  const registration = await currentRegistration(container);
  const current = registeredScript(registration);
  if (registration && current && current !== requiredUrl) {
    await enterTransition(registration, current, requiredId, requiredUrl);
    return;
  }
  state.pendingTransition = null;
  if (state.status.transition?.status === "transition-required")
    publish({ transition: null });
  await ensureRegistered(container, current, requiredUrl);
  publishVariant(current, requiredId);
  syncPlan(snapshot);
}

/**
 * Follow the composition store and keep the registered worker in step with
 * the plan. Returns the unsubscribe. With no `serviceWorker` the status says
 * `supported: false` and nothing else happens; on a cross-origin-isolated
 * page nothing new is registered (the worker that isolated it already is),
 * though an existing controller still receives the plan.
 */
export function registerWorkerForPlan(
  store: CompositionStoreForWorker,
  options: RegisterWorkerOptions,
): () => void {
  const container = workerControllerSeams.serviceWorkerContainer();
  if (!container) {
    publish({ supported: false });
    return () => undefined;
  }
  state.container = container;
  state.distribution = options.distribution;
  attachContainerListeners(container);
  const apply = () => {
    const snapshot = store.getSnapshot();
    state.latest = snapshot;
    state.reconciling = state.reconciling
      .then(() => reconcile(snapshot))
      .catch(() => undefined);
  };
  const unsubscribe = store.subscribe(apply);
  apply();
  // What the worker saved flows back to the store, which projects it onto
  // each capability's lifecycle (`cached-offline`) without resolving again.
  let reported: readonly string[] = [];
  const stopSaved = subscribeWorkerStatus(() => {
    const saved = state.status.savedModuleIds;
    if (saved === reported) return;
    reported = saved;
    store.setOfflineSaved?.(saved);
  });
  return () => {
    unsubscribe();
    stopSaved();
  };
}

/** Settle after the last `registerWorkerForPlan` pass (tests, transitions). */
export function workerControllerSettled(): Promise<void> {
  return state.reconciling;
}

/**
 * Perform the transition a `transition-required` status describes: register
 * the required script over the registration that holds the other one. The
 * registration is never unregistered, so there is no moment without a worker
 * and a push subscription survives a change of script. The new worker
 * installs, skips waiting and claims the page; the old one keeps serving until
 * it does. Resolves `false` when nothing is pending or the registration was
 * refused (the old worker keeps the scope and the status says why).
 */
export async function transitionWorker(): Promise<boolean> {
  const pending = state.pendingTransition;
  const container = state.container;
  if (!pending || !container) return false;
  const from = state.status.transition?.from ?? null;
  state.pendingTransition = null;
  publish({ transition: { from, to: pending.to, status: "transitioning" } });
  state.variantSwitch = true;
  if (!(await register(container, pending.scriptUrl))) {
    state.variantSwitch = false;
    publish({ transition: null });
    return false;
  }
  // Leaving the push variant: the worker that now holds the scope has no
  // `push` handler, so a subscription left behind would show the browser's own
  // "updated in the background" notice for every push.
  if (from === "push" && pending.to !== "push")
    await dropPushSubscription(pending.registration);
  state.workerReleaseId = null;
  state.lastPlanKey = null;
  publish({ variant: pending.to, transition: null });
  // The change of controller may have been seen while the status still said
  // "transitioning", when the worker conversation is silent: say hello now
  // unless that change is still to come (it will, then).
  if (!state.variantSwitch && state.latest) syncPlan(state.latest);
  return true;
}

async function dropPushSubscription(
  registration: ServiceWorkerRegistration,
): Promise<void> {
  try {
    await (await registration.pushManager?.getSubscription())?.unsubscribe();
  } catch {
    // No subscription to drop, or the browser already dropped it.
  }
}
