/**
 * The fake page platform the worker-controller tests run against.
 *
 * A `ServiceWorkerContainer` that records every registration, message and
 * unregistration; a composition store whose snapshot the test moves by hand;
 * and the plan/selection/receipt fixtures those two are driven with. Nothing
 * here imports vitest — a test file owns its own lifecycle hooks and calls
 * `installSeams` / `restoreSeams`.
 */

import type {
  ConsentReceipt,
  DistributionContract,
  EffectivePlan,
  InstallationCapabilitySelection,
} from "@opensesame/capability-composition";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import {
  registerWorkerForPlan,
  workerControllerSettled,
} from "../worker-controller.js";
import { workerControllerSeams } from "./seams.js";
import { resetWorkerController } from "./state.js";
import type {
  CompositionSnapshotForWorker,
  CompositionStoreForWorker,
  PageToWorkerMessage,
} from "./types.js";

export const BASE = "https://example.test/OpenSesame/";
export const CORE_URL = `${BASE}sw.js`;
export const PUSH_URL = `${BASE}sw-push.js`;

export const DISTRIBUTION: DistributionContract = {
  distributionId: "dist-1",
  mode: "selective",
  capabilityIds: [
    "vault.passwords",
    "connectors.external",
    "notifications.web-push",
  ],
  moduleIds: [
    "connectors.external/runtime",
    "notifications.web-push/runtime",
    "notifications.web-push/worker",
  ],
  workerVariants: [
    { id: "core-only", scriptPath: "sw.js", satisfies: [] },
    { id: "push", scriptPath: "sw-push.js", satisfies: ["push"] },
  ],
  basePath: "/OpenSesame/",
};

export const CORE_ONLY_DISTRIBUTION: DistributionContract = {
  ...DISTRIBUTION,
  workerVariants: [{ id: "core-only", scriptPath: "sw.js", satisfies: [] }],
};

export type PlanInput = Readonly<{
  requiredWorkerVariant?: string | null;
  approvedCapabilities?: readonly string[];
  approvedModules?: readonly string[];
  planDigest?: string;
}>;

export function plan(input: PlanInput = {}): EffectivePlan {
  return {
    identity: {
      instanceId: "inst",
      installationId: "install",
      vaultId: null,
      distributionId: "dist-1",
      policyRevision: "p1",
      selectionRevision: "s1",
      planDigest: input.planDigest ?? "sha256:plan1",
    },
    provenance: "personal-local",
    policyValid: true,
    capabilities: {},
    approvedCapabilities: input.approvedCapabilities ?? ["vault.passwords"],
    approvedModules: input.approvedModules ?? [],
    approvedOperations: [],
    approvedItemKinds: [],
    requiredWorkerVariant: input.requiredWorkerVariant ?? null,
    conflicts: [],
    consent: {
      addedRoots: [],
      removedRoots: [],
      changedExposure: [],
      addedDependencies: [],
      requiredNotAccepted: [],
    },
    network: { externalServices: "deny", allowedServiceOrigins: [] },
  };
}

export function selection(
  offlineCache: "shell-only" | "selected-only",
): InstallationCapabilitySelection {
  return {
    schemaVersion: 1,
    kind: "InstallationCapabilitySelection",
    instanceId: "inst",
    installationId: "install",
    basePolicyRevision: "p1",
    revision: "s1",
    acceptedRequired: [],
    selectedOptional: ["connectors.external"],
    chosenAlternatives: {},
    delivery: { prefetch: "none", offlineCache },
  };
}

export function receipt(
  capability: string,
  digest = "sha256:x",
): ConsentReceipt {
  const exposure = { [capability]: digest };
  return {
    schemaVersion: 1,
    instanceId: "inst",
    installationId: "install",
    policyRevision: "p1",
    selectionRevision: "s1",
    acceptedAt: "2026-09-22T00:00:00.000Z",
    roots: Object.keys(exposure),
    exposure,
    receiptDigest: "sha256:receipt",
  };
}

export class FakeStore implements CompositionStoreForWorker {
  private snapshot: CompositionSnapshotForWorker;
  private readonly listeners = new Set<() => void>();

  constructor(snapshot: CompositionSnapshotForWorker) {
    this.snapshot = snapshot;
  }

  getSnapshot(): CompositionSnapshotForWorker {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(snapshot: CompositionSnapshotForWorker): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  /** Every `setOfflineSaved` report, in order. */
  readonly savedReports: (readonly string[])[] = [];

  setOfflineSaved(moduleIds: readonly string[]): void {
    this.savedReports.push(moduleIds);
  }
}

type Handler = (event: { data: JsonObject }) => void;

/** A worker the fake registration holds; `set` is the browser moving it on. */
export class FakeWorker {
  private readonly listeners = new Set<() => void>();
  constructor(
    readonly scriptURL: string,
    public state: ServiceWorkerState = "installing",
  ) {}
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.listeners.delete(listener);
  }
  set(state: ServiceWorkerState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

/** What a replacement script does once registered. */
export type InstallOutcome = "activate" | "redundant" | "hang";

export class FakeContainer {
  readonly registered: {
    url: string;
    options: RegistrationOptions | undefined;
  }[] = [];
  readonly posted: PageToWorkerMessage[] = [];
  readonly unregistered: string[] = [];
  /** Push subscriptions the registration holds; `unsubscribe` records here. */
  readonly pushUnsubscribed: string[] = [];
  holdsPushSubscription = false;
  /** A script that is still installing (a replacement the page asked for). */
  installingScript: string | null = null;
  /** Make the next `register` reject, as a refused or offline script does. */
  registerFails = false;
  /** Whether a replacement takes the page (`controllerchange`) on register. */
  claimOnRegister = false;
  /** What a script registered over the scope does. */
  installOutcome: InstallOutcome = "activate";
  /**
   * How many registrations install and then sit `installed` for ever, as
   * Chrome leaves a replacement when another tab restarts the old worker as
   * it is being stopped. The next registration, under a new URL, activates.
   */
  wedges = 0;
  /** The wedged worker, if one sits waiting. */
  waitingWorker: FakeWorker | null = null;
  /** The worker of the last `register`, for a test that makes it move on. */
  lastInstalling: FakeWorker | null = null;
  activeScript: string | null;
  hasController: boolean;
  private readonly handlers = new Map<string, Handler[]>();

  constructor(
    activeScript: string | null,
    hasController = activeScript !== null,
  ) {
    this.activeScript = activeScript;
    this.hasController = hasController;
  }

  get controller(): { postMessage: (m: PageToWorkerMessage) => void } | null {
    if (!this.hasController) return null;
    return { postMessage: (m) => this.posted.push(m) };
  }

  /** The browser finishing the install the last `register` started. */
  finishInstall(outcome: "activate" | "redundant"): void {
    const worker = this.lastInstalling;
    if (!worker) return;
    this.installingScript = null;
    if (outcome === "activate") {
      this.activeScript = worker.scriptURL;
      worker.set("activated");
      if (this.claimOnRegister) this.emit("controllerchange");
    } else worker.set("redundant");
  }

  private view() {
    const script = this.activeScript;
    return {
      active: script ? new FakeWorker(script, "activated") : null,
      installing: this.installingScript
        ? (this.lastInstalling ?? new FakeWorker(this.installingScript))
        : null,
      waiting: this.waitingWorker,
      pushManager: {
        getSubscription: async () =>
          this.holdsPushSubscription
            ? {
                unsubscribe: async () => {
                  this.pushUnsubscribed.push(script ?? "");
                  this.holdsPushSubscription = false;
                  return true;
                },
              }
            : null,
      },
      unregister: async () => {
        this.unregistered.push(script ?? "");
        this.activeScript = null;
        return true;
      },
    };
  }

  async register(url: string, options?: RegistrationOptions) {
    this.registered.push({ url, options });
    if (this.registerFails) throw new TypeError("script fetch failed");
    const worker = new FakeWorker(url);
    this.lastInstalling = worker;
    if (this.wedges > 0) {
      this.wedges -= 1;
      this.waitingWorker?.set("redundant");
      worker.state = "installed";
      this.waitingWorker = worker;
      return { ...this.view(), installing: null };
    }
    if (this.waitingWorker) {
      // A new version replaces the one waiting.
      this.waitingWorker.set("redundant");
      this.waitingWorker = null;
    }
    if (this.installOutcome === "activate") {
      this.activeScript = url;
      worker.state = "activated";
      this.installingScript = null;
      if (this.claimOnRegister) this.emit("controllerchange");
    } else if (this.installOutcome === "redundant") {
      worker.state = "redundant";
      this.installingScript = null;
    } else this.installingScript = url;
    const registration = this.view();
    // A redundant worker is not held by the registration for long; it is
    // returned as installing only so the caller can watch it fail.
    const watched = this.installOutcome !== "activate";
    return {
      ...registration,
      active: this.activeScript
        ? this.activeScript === url
          ? worker
          : new FakeWorker(this.activeScript, "activated")
        : null,
      installing: watched ? worker : null,
    };
  }

  async getRegistration() {
    if (!this.activeScript && !this.installingScript) return undefined;
    return this.view();
  }

  addEventListener(
    type: string,
    handler: Handler,
    options?: { once?: boolean },
  ): void {
    const list = this.handlers.get(type) ?? [];
    const wrapped: Handler = options?.once
      ? (event) => {
          this.handlers.set(
            type,
            (this.handlers.get(type) ?? []).filter((h) => h !== wrapped),
          );
          handler(event);
        }
      : handler;
    list.push(wrapped);
    this.handlers.set(type, list);
  }

  emit(type: string, data?: JsonObject): void {
    for (const handler of [...(this.handlers.get(type) ?? [])])
      handler({ data: data ?? {} });
  }

  asContainer(): ServiceWorkerContainer {
    // SAFETY: the controller reads controller, register, getRegistration and
    // addEventListener; the fake implements those and nothing else is reached.
    return overlapCast(this);
  }
}

const original = { ...workerControllerSeams };

/** What the seams did, for a test to assert on. */
type HarnessEnv = {
  reloads: number;
  isolated: boolean;
  timers: { run: () => void; ms: number; live: boolean }[];
  /** Run every timer of at most `upToMs` still waiting, as if its time had come. */
  elapse: (upToMs?: number) => void;
};

export const env: HarnessEnv = {
  reloads: 0,
  isolated: false,
  timers: [],
  elapse(upToMs = Number.POSITIVE_INFINITY) {
    for (const timer of [...env.timers]) {
      if (!timer.live || timer.ms > upToMs) continue;
      timer.live = false;
      timer.run();
    }
  },
};

/** Fresh controller state and fresh seams; call from `beforeEach`. */
export function installSeams(): void {
  resetWorkerController();
  env.reloads = 0;
  env.isolated = false;
  env.timers = [];
  workerControllerSeams.later = (run, ms) => {
    const timer = { run, ms, live: true };
    env.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  workerControllerSeams.baseUrl = () => BASE;
  workerControllerSeams.crossOriginIsolated = () => env.isolated;
  workerControllerSeams.reload = () => {
    env.reloads += 1;
  };
}

/** Put the real seams back; call from `afterEach`. */
export function restoreSeams(): void {
  Object.assign(workerControllerSeams, original);
}

/** Point the controller at a fake container and start it on a store. */
export function arm(
  container: FakeContainer | null,
  store: FakeStore,
  distribution = DISTRIBUTION,
): Readonly<{ stop: () => void; settled: () => Promise<void> }> {
  workerControllerSeams.serviceWorkerContainer = () =>
    container?.asContainer() ?? null;
  const stop = registerWorkerForPlan(store, { distribution });
  return { stop, settled: workerControllerSettled };
}
