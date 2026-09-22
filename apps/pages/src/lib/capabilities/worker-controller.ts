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
 * `PLAN_ASSETS`. It never posts a URL. The worker's answers become the
 * `offlineStatus` a settings surface reads through `useWorkerStatus`.
 *
 * Nothing here imports `virtual:pwa-register` or workbox-window: the
 * registration call is the platform's own.
 */

import type {
  ConsentReceipt,
  DistributionContract,
  EffectivePlan,
  InstallationCapabilitySelection,
} from "@opensesame/capability-composition";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { useSyncExternalStore } from "react";

export type OfflineStatus =
  | "online-only"
  | "saving"
  | "saved"
  | "partial"
  | "storage-unavailable";

export type WorkerTransition = Readonly<{
  from: string | null;
  to: string;
  status: "transition-required" | "transitioning";
}>;

export type WorkerStatus = Readonly<{
  /** False when the page has no usable `navigator.serviceWorker`. */
  supported: boolean;
  /** Variant of the script registered for this scope, when known. */
  variant: string | null;
  /** Variant the current plan requires (`core-only` when the plan says null). */
  requiredVariant: string | null;
  /** The controlling worker's release id, from `WORKER_INFO`. */
  releaseId: string | null;
  offlineStatus: OfflineStatus;
  transition: WorkerTransition | null;
  /** Human-readable, never secrets. */
  diagnostics: readonly string[];
}>;

/** The slice of §4.1's snapshot this controller reads. */
export type CompositionSnapshotForWorker = Readonly<{
  plan: EffectivePlan | null;
  selection: InstallationCapabilitySelection | null;
  receipt: ConsentReceipt | null;
}>;

export type CompositionStoreForWorker = Readonly<{
  getSnapshot(): CompositionSnapshotForWorker;
  subscribe(listener: () => void): () => void;
}>;

export type RegisterWorkerOptions = Readonly<{
  /** `virtual:opensesame-distribution`'s `DISTRIBUTION` (S07). */
  distribution: DistributionContract;
}>;

export const CORE_ONLY_VARIANT = "core-only";
export const WORKER_GRAPH_UNAVAILABLE = "WORKER_GRAPH_UNAVAILABLE";

/** The capability a non-core variant exists for; registration waits on it. */
const VARIANT_CAPABILITY = new Map<string, string>([
  ["push", "notifications.web-push"],
]);

function serviceWorkerContainerDefault(): ServiceWorkerContainer | null {
  const scope: { navigator?: { serviceWorker?: ServiceWorkerContainer } } =
    overlapCast(globalThis);
  return scope.navigator?.serviceWorker ?? null;
}

function crossOriginIsolatedDefault(): boolean {
  const scope: { crossOriginIsolated?: boolean } = overlapCast(globalThis);
  return scope.crossOriginIsolated === true;
}

function baseUrlDefault(): string {
  const scope: { location?: { href: string } } = overlapCast(globalThis);
  return new URL(
    import.meta.env.BASE_URL,
    scope.location?.href ?? "https://localhost/",
  ).href;
}

function reloadDefault(): void {
  const scope: { location?: { reload: () => void } } = overlapCast(globalThis);
  scope.location?.reload();
}

export const workerControllerSeams = {
  serviceWorkerContainer: serviceWorkerContainerDefault,
  crossOriginIsolated: crossOriginIsolatedDefault,
  baseUrl: baseUrlDefault,
  reload: reloadDefault,
};

type PendingTransition = Readonly<{
  registration: ServiceWorkerRegistration;
  scriptUrl: string;
  to: string;
}>;

type ControllerState = {
  status: WorkerStatus;
  container: ServiceWorkerContainer | null;
  distribution: DistributionContract | null;
  latest: CompositionSnapshotForWorker | null;
  registeredThisPage: boolean;
  listenersAttached: boolean;
  workerReleaseId: string | null;
  lastPlanKey: string | null;
  pendingTransition: PendingTransition | null;
  reconciling: Promise<void>;
};

const INITIAL_STATUS: WorkerStatus = {
  supported: true,
  variant: null,
  requiredVariant: null,
  releaseId: null,
  offlineStatus: "online-only",
  transition: null,
  diagnostics: [],
};

function initialState(): ControllerState {
  return {
    status: INITIAL_STATUS,
    container: null,
    distribution: null,
    latest: null,
    registeredThisPage: false,
    listenersAttached: false,
    workerReleaseId: null,
    lastPlanKey: null,
    pendingTransition: null,
    reconciling: Promise.resolve(),
  };
}

let state = initialState();
const listeners = new Set<() => void>();

function publish(patch: Partial<WorkerStatus>): void {
  state.status = { ...state.status, ...patch };
  for (const listener of listeners) listener();
}

function diagnose(code: string): void {
  if (state.status.diagnostics.includes(code)) return;
  publish({ diagnostics: [...state.status.diagnostics, code] });
}

/** Test seam: forget every page-level decision. */
export function resetWorkerController(): void {
  state = initialState();
  for (const listener of listeners) listener();
}

function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function workerStatus(): WorkerStatus {
  return state.status;
}

export function useWorkerStatus(): WorkerStatus {
  return useSyncExternalStore(subscribeStatus, workerStatus, workerStatus);
}

function scriptUrlFor(scriptPath: string): string {
  return new URL(scriptPath, workerControllerSeams.baseUrl()).href;
}

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

function postToController(message: object): boolean {
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

function syncPlan(snapshot: CompositionSnapshotForWorker): void {
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

function onWorkerMessage(data: BoundaryValue): void {
  if (!isJsonObject(data) || !isString(data.type)) return;
  switch (data.type) {
    case "WORKER_INFO":
      if (!isString(data.releaseId)) return;
      state.workerReleaseId = data.releaseId;
      publish({ releaseId: data.releaseId });
      if (state.latest) syncPlan(state.latest);
      return;
    case "OFFLINE_READY":
      publish({ offlineStatus: "saved" });
      return;
    case "OFFLINE_PARTIAL":
      publish({ offlineStatus: "partial" });
      return;
    case "OFFLINE_STORAGE_UNAVAILABLE":
      publish({ offlineStatus: "storage-unavailable" });
      return;
    case "PLAN_REJECTED":
      diagnose(
        `PLAN_REJECTED:${isString(data.reason) ? data.reason : "unknown"}`,
      );
      publish({ offlineStatus: "online-only" });
      if (data.reason === "release-mismatch") {
        // The controller changed under us; ask again and repost.
        state.workerReleaseId = null;
        state.lastPlanKey = null;
        if (state.latest) syncPlan(state.latest);
      }
      return;
    default:
      return;
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
  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await container.getRegistration(
      workerControllerSeams.baseUrl(),
    );
  } catch {
    registration = undefined;
  }
  const current = registeredScript(registration);
  if (current && current !== requiredUrl && registration) {
    state.pendingTransition = {
      registration,
      scriptUrl: requiredUrl,
      to: requiredId,
    };
    publish({
      variant: variantOfScript(current),
      transition: {
        from: variantOfScript(current),
        to: requiredId,
        status: "transition-required",
      },
    });
    return;
  }
  state.pendingTransition = null;
  if (state.status.transition?.status === "transition-required")
    publish({ transition: null });
  if (
    !current &&
    !state.registeredThisPage &&
    !workerControllerSeams.crossOriginIsolated()
  ) {
    await register(container, requiredUrl);
  }
  publish({
    variant: current
      ? variantOfScript(current)
      : state.registeredThisPage
        ? requiredId
        : null,
  });
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
