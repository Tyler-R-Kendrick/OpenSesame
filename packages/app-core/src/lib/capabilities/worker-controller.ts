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
 * only when ready — the status reports the variant that is *active*, and the
 * one installing only as `pendingVariant` — and a page it takes over reloads
 * only for a different release, never for another variant of the one it runs,
 * in this tab or any other (`onControllerChange`). `transition-required` stays
 * visible for the moment between noticing the difference and acting on it.
 * A replacement that never activates (a failed install, a timeout) leaves the
 * worker the person has in charge and says so (`WORKER_INSTALL_FAILED`).
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
import { retirePushSubscriptionId } from "../web-push-ledger.js";
import { activeScript, becomesActive } from "./worker/activation.js";
import {
  askWorker,
  onControllerChange,
  onWorkerMessage,
  syncPlan,
} from "./worker/plan-sync.js";
import {
  freshScriptUrl,
  newestAttempt,
  scheduleRecheck,
  stuckWaiting,
  takeRecoveryTurn,
} from "./worker/recover.js";
import {
  currentRegistration,
  newestScript,
  register,
  variantEligible,
  variantOfScript,
} from "./worker/registration.js";
import {
  sameScript,
  scriptUrlAttempt,
  scriptUrlFor,
  workerControllerSeams,
} from "./worker/seams.js";
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

function attachContainerListeners(container: ServiceWorkerContainer): void {
  if (state.listenersAttached) return;
  state.listenersAttached = true;
  container.addEventListener("message", (event) => {
    // SAFETY: a worker message's data is whatever the worker posted; the
    // handler narrows it field by field before reading anything.
    onWorkerMessage(overlapCast(event.data));
  });
  container.addEventListener("controllerchange", onControllerChange);
  state.afterTakeover = () => void refreshVariant(container);
}

/** Re-read which variant holds the scope, and introduce the plan to it. */
async function refreshVariant(
  container: ServiceWorkerContainer,
): Promise<void> {
  const registration = await currentRegistration(container);
  publish({ variant: variantOfScript(activeScript(registration)) });
  if (state.latest) syncPlan(state.latest);
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

/** Ask for the same script again under a fresh URL (`worker/activation.ts`). */
function askAgain(container: ServiceWorkerContainer, scriptUrl: string) {
  return async () =>
    register(
      container,
      freshScriptUrl(await currentRegistration(container), scriptUrl),
    );
}

/** Run the reconcile again on the latest snapshot, after the one in flight. */
function reconcileAgain(): void {
  const snapshot = state.latest;
  if (!snapshot) return;
  state.reconciling = state.reconciling
    .then(() => reconcile(snapshot))
    .catch(() => undefined);
}

/**
 * A replacement gave up on at the bound that is still waiting is a transition
 * that did not finish: come back to it later (`worker/recover.ts`).
 */
async function recheckIfStuck(
  container: ServiceWorkerContainer,
  requiredUrl: string,
): Promise<void> {
  if (stuckWaiting(await currentRegistration(container), requiredUrl))
    scheduleRecheck(reconcileAgain);
}

/** Try the required script again, fresh, through the ordinary transition. */
async function recoverStuck(
  registration: ServiceWorkerRegistration,
  requiredId: string,
  requiredUrl: string,
): Promise<void> {
  if (!takeRecoveryTurn()) return;
  const from = variantOfScript(activeScript(registration));
  state.pendingTransition = {
    registration,
    scriptUrl: scriptUrlAttempt(requiredUrl, newestAttempt(registration) + 1),
    to: requiredId,
  };
  publish({
    variant: from,
    transition: { from, to: requiredId, status: "transition-required" },
  });
  await transitionWorker();
}

/** The first registration of this page, and the worker it becomes. */
async function ensureRegistered(
  container: ServiceWorkerContainer,
  current: string | null,
  requiredId: string,
  requiredUrl: string,
): Promise<void> {
  if (current) return;
  if (state.registeredThisPage) return;
  if (workerControllerSeams.crossOriginIsolated()) return;
  const registration = await register(container, requiredUrl);
  if (!registration) return;
  publish({ pendingVariant: requiredId });
  const active = await becomesActive(
    registration,
    requiredUrl,
    askAgain(container, requiredUrl),
  );
  publish({ pendingVariant: null, variant: active ? requiredId : null });
  if (!active) diagnose("WORKER_INSTALL_FAILED");
  if (!active) await recheckIfStuck(container, requiredUrl);
}

/** What runs is the active worker; a newer one still installing is pending. */
function publishVariant(registration: ServiceWorkerRegistration | undefined) {
  const newest = variantOfScript(newestScript(registration));
  const active = variantOfScript(activeScript(registration));
  if (!registration) return;
  publish({
    variant: active,
    pendingVariant: newest !== active ? newest : null,
  });
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
  const current = newestScript(registration);
  if (registration && current && !sameScript(current, requiredUrl)) {
    await enterTransition(registration, current, requiredId, requiredUrl);
    return;
  }
  state.pendingTransition = null;
  if (state.status.transition?.status === "transition-required")
    publish({ transition: null });
  if (registration && stuckWaiting(registration, requiredUrl)) {
    await recoverStuck(registration, requiredId, requiredUrl);
    return;
  }
  await ensureRegistered(container, current, requiredId, requiredUrl);
  publishVariant(registration);
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
  // A page that starts under a worker learns which release that is; it is what
  // a later change of controller is compared with (`onControllerChange`).
  state.bootControlled = container.controller != null;
  if (state.bootControlled) askWorker();
  const apply = () => {
    state.latest = store.getSnapshot();
    reconcileAgain();
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
    state.recheckCancel?.();
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
  publish({
    pendingVariant: pending.to,
    transition: { from, to: pending.to, status: "transitioning" },
  });
  const registration = await register(container, pending.scriptUrl);
  const active =
    registration !== null &&
    (await becomesActive(
      registration,
      pending.scriptUrl,
      askAgain(container, pending.scriptUrl),
    ));
  if (!registration || !active) {
    // The worker the person has stays in charge; the next plan change tries
    // again. Nothing that depended on the new one happens.
    if (registration) diagnose("WORKER_INSTALL_FAILED");
    publish({ pendingVariant: null, transition: null });
    if (registration) await recheckIfStuck(container, pending.scriptUrl);
    return false;
  }
  // Leaving the push variant, now that the core worker really holds the scope:
  // it has no `push` handler, so a subscription left behind would show the
  // browser's own "updated in the background" notice for every push, and the
  // stored id moves to the pending list for the Identity API to forget.
  if (from === "push" && pending.to !== "push")
    await dropPushSubscription(registration);
  publish({ variant: pending.to, pendingVariant: null, transition: null });
  // The claim may have been seen while the status still said "transitioning",
  // when the worker conversation is silent: say hello now unless the answer to
  // the claim's own question is still to come.
  if (!state.takeover && state.latest) syncPlan(state.latest);
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
  await retirePushSubscriptionId().catch(() => undefined);
}
