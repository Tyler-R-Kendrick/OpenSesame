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
}

type Handler = (event: { data: JsonObject }) => void;

export class FakeContainer {
  readonly registered: {
    url: string;
    options: RegistrationOptions | undefined;
  }[] = [];
  readonly posted: PageToWorkerMessage[] = [];
  readonly unregistered: string[] = [];
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

  async register(url: string, options?: RegistrationOptions): Promise<void> {
    this.registered.push({ url, options });
    this.activeScript = url;
  }

  async getRegistration(): Promise<
    | {
        active: { scriptURL: string } | null;
        unregister: () => Promise<boolean>;
      }
    | undefined
  > {
    if (!this.activeScript) return undefined;
    const script = this.activeScript;
    return {
      active: { scriptURL: script },
      unregister: async () => {
        this.unregistered.push(script);
        this.activeScript = null;
        return true;
      },
    };
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
export const env = { reloads: 0, isolated: false };

/** Fresh controller state and fresh seams; call from `beforeEach`. */
export function installSeams(): void {
  resetWorkerController();
  env.reloads = 0;
  env.isolated = false;
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
