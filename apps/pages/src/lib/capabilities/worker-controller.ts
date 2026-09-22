/**
 * Service-worker registration driven by the effective plan (ownership.md
 * §4.7; PWA-02, PWA-03, PWA-06).
 *
 * The plan names the worker variant an installation must run
 * (`requiredWorkerVariant`, `null` meaning core-only) and the distribution
 * says which script each variant is. This controller registers that script —
 * once per page, only when the plan is core-only or the installation has a
 * persisted selection and receipt covering the capability the variant serves
 * — and never registers a second, competing worker: when the controlling
 * script differs from the required one it exposes a `transition-required`
 * state and moves only on an explicit `transitionWorker()` call.
 *
 * Once a worker controls the page the controller asks it who it is
 * (`WORKER_HELLO` → `WORKER_INFO`) and, when the selection asks for
 * `selected-only` offline delivery, posts the approved module ids as
 * `PLAN_ASSETS` (`worker/plan-sync.ts`). It never posts a URL. The worker's
 * answers become the `offlineStatus` a settings surface reads through
 * `useWorkerStatus`.
 *
 * The parts live under `worker/`: the platform seams, the page-level state
 * and its external store, the plan conversation, and the shared types.
 * Nothing here imports `virtual:pwa-register` or workbox-window: the
 * registration call is the platform's own.
 */

import { overlapCast } from "@opensesame/os-domain";
import { onWorkerMessage, syncPlan } from "./worker/plan-sync.js";
import { scriptUrlFor, workerControllerSeams } from "./worker/seams.js";
import { diagnose, publish, state } from "./worker/state.js";
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
  useWorkerStatus,
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

function registeredScript(
  registration: ServiceWorkerRegistration | undefined,
): string | null {
  if (!registration) return null;
  return (
    registration.active?.scriptURL ??
    registration.waiting?.scriptURL ??
    registration.installing?.scriptURL ??
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
): Promise<void> {
  state.registeredThisPage = true;
  try {
    await container.register(scriptUrl, {
      type: "classic",
      updateViaCache: "none",
      scope: workerControllerSeams.baseUrl(),
    });
  } catch {
    diagnose("WORKER_REGISTRATION_FAILED");
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
  // A new worker took the page: the shell it was served by may reference
  // assets the new release deleted, so the page reloads — as it always did.
  container.addEventListener(
    "controllerchange",
    () => {
      workerControllerSeams.reload();
    },
    { once: true },
  );
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

/** Another variant holds this scope: say so and wait to be told to move. */
function enterTransition(
  registration: ServiceWorkerRegistration,
  current: string,
  requiredId: string,
  requiredUrl: string,
): void {
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
    enterTransition(registration, current, requiredId, requiredUrl);
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
  return unsubscribe;
}

/** Settle after the last `registerWorkerForPlan` pass (tests, transitions). */
export function workerControllerSettled(): Promise<void> {
  return state.reconciling;
}

/**
 * Perform the transition a `transition-required` status describes: retire
 * the registration for the other variant, register the required one. The
 * new worker's `controllerchange` reloads the page. Resolves `false` when no
 * transition is pending.
 */
export async function transitionWorker(): Promise<boolean> {
  const pending = state.pendingTransition;
  const container = state.container;
  if (!pending || !container) return false;
  const from = state.status.transition?.from ?? null;
  publish({ transition: { from, to: pending.to, status: "transitioning" } });
  state.pendingTransition = null;
  try {
    await pending.registration.unregister();
  } catch {
    // An already-gone registration is the state being asked for.
  }
  state.registeredThisPage = false;
  await register(container, pending.scriptUrl);
  state.workerReleaseId = null;
  state.lastPlanKey = null;
  publish({ variant: pending.to, transition: null });
  return true;
}
