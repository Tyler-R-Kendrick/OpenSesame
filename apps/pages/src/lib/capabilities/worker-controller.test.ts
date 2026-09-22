import type {
  ConsentReceipt,
  DistributionContract,
  EffectivePlan,
  InstallationCapabilitySelection,
} from "@opensesame/capability-composition";
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CompositionSnapshotForWorker,
  type CompositionStoreForWorker,
  WORKER_GRAPH_UNAVAILABLE,
  registerWorkerForPlan,
  resetWorkerController,
  transitionWorker,
  workerControllerSeams,
  workerControllerSettled,
  workerStatus,
} from "./worker-controller.js";

const BASE = "https://example.test/OpenSesame/";
const CORE_URL = `${BASE}sw.js`;
const PUSH_URL = `${BASE}sw-push.js`;

const DISTRIBUTION: DistributionContract = {
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

const CORE_ONLY_DISTRIBUTION: DistributionContract = {
  ...DISTRIBUTION,
  workerVariants: [{ id: "core-only", scriptPath: "sw.js", satisfies: [] }],
};

type PlanInput = Readonly<{
  requiredWorkerVariant?: string | null;
  approvedCapabilities?: readonly string[];
  approvedModules?: readonly string[];
  planDigest?: string;
}>;

function plan(input: PlanInput = {}): EffectivePlan {
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

function selection(
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

function receipt(exposure: Readonly<Record<string, string>>): ConsentReceipt {
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

class FakeStore implements CompositionStoreForWorker {
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

type Handler = (event: { data: object }) => void;

class FakeContainer {
  readonly registered: {
    url: string;
    options: RegistrationOptions | undefined;
  }[] = [];
  readonly posted: object[] = [];
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

  get controller(): { postMessage: (m: object) => void } | null {
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

  emit(type: string, data: object = {}): void {
    for (const handler of [...(this.handlers.get(type) ?? [])])
      handler({ data });
  }

  asContainer(): ServiceWorkerContainer {
    // SAFETY: the controller reads controller, register, getRegistration and
    // addEventListener; the fake implements those and nothing else is reached.
    return overlapCast(this);
  }
}

const original = { ...workerControllerSeams };
let reloads = 0;
let isolated = false;

beforeEach(() => {
  resetWorkerController();
  reloads = 0;
  isolated = false;
  workerControllerSeams.baseUrl = () => BASE;
  workerControllerSeams.crossOriginIsolated = () => isolated;
  workerControllerSeams.reload = () => {
    reloads += 1;
  };
});

afterEach(() => {
  Object.assign(workerControllerSeams, original);
});

function arm(
  container: FakeContainer | null,
  store: FakeStore,
  distribution = DISTRIBUTION,
) {
  workerControllerSeams.serviceWorkerContainer = () =>
    container?.asContainer() ?? null;
  const stop = registerWorkerForPlan(store, { distribution });
  return { stop, settled: workerControllerSettled };
}

describe("variant selection (PWA-02)", () => {
  it("registers the core-only script once, classic and never via cache, for a null variant", async () => {
    const container = new FakeContainer(null);
    const store = new FakeStore({
      plan: plan(),
      selection: null,
      receipt: null,
    });
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered).toEqual([
      {
        url: CORE_URL,
        options: { type: "classic", updateViaCache: "none", scope: BASE },
      },
    ]);
    store.set({
      plan: plan({ planDigest: "sha256:plan2" }),
      selection: null,
      receipt: null,
    });
    await settled();
    expect(container.registered).toHaveLength(1);
    expect(workerStatus().variant).toBe("core-only");
    expect(workerStatus().requiredVariant).toBe("core-only");
  });

  it("does nothing without a service worker container", async () => {
    const store = new FakeStore({
      plan: plan(),
      selection: null,
      receipt: null,
    });
    const { settled } = arm(null, store);
    await settled();
    expect(workerStatus().supported).toBe(false);
  });

  it("does not register on a cross-origin-isolated page", async () => {
    isolated = true;
    const container = new FakeContainer(null);
    const store = new FakeStore({
      plan: plan(),
      selection: null,
      receipt: null,
    });
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered).toEqual([]);
  });

  it("waits for a plan before deciding anything", async () => {
    const container = new FakeContainer(null);
    const store = new FakeStore({ plan: null, selection: null, receipt: null });
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered).toEqual([]);
    store.set({ plan: plan(), selection: null, receipt: null });
    await settled();
    expect(container.registered.map((r) => r.url)).toEqual([CORE_URL]);
  });
});

describe("push variant gating (PWA-03)", () => {
  const pushPlan = plan({
    requiredWorkerVariant: "push",
    approvedCapabilities: ["notifications.web-push", "vault.passwords"],
    approvedModules: [
      "notifications.web-push/runtime",
      "notifications.web-push/worker",
    ],
  });

  it("does not register the push worker without a persisted selection and receipt", async () => {
    const container = new FakeContainer(null);
    const store = new FakeStore({
      plan: pushPlan,
      selection: null,
      receipt: null,
    });
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered).toEqual([]);
    store.set({
      plan: pushPlan,
      selection: selection("shell-only"),
      receipt: receipt({ "vault.passwords": "d" }),
    });
    await settled();
    expect(container.registered).toEqual([]);
  });

  it("registers it once the capability is approved and in the receipt", async () => {
    const container = new FakeContainer(null);
    const store = new FakeStore({
      plan: pushPlan,
      selection: selection("shell-only"),
      receipt: receipt({ "notifications.web-push": "sha256:x" }),
    });
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered.map((r) => r.url)).toEqual([PUSH_URL]);
    expect(workerStatus().variant).toBe("push");
  });

  it("publishes WORKER_GRAPH_UNAVAILABLE when the distribution lacks the variant", async () => {
    const container = new FakeContainer(null);
    const store = new FakeStore({
      plan: pushPlan,
      selection: selection("shell-only"),
      receipt: receipt({ "notifications.web-push": "sha256:x" }),
    });
    const { settled } = arm(container, store, CORE_ONLY_DISTRIBUTION);
    await settled();
    expect(container.registered).toEqual([]);
    expect(workerStatus().diagnostics).toContain(WORKER_GRAPH_UNAVAILABLE);
    expect(workerStatus().requiredVariant).toBe("push");
  });
});

describe("transitions (PWA-02, PWA-06)", () => {
  it("exposes transition-required instead of registering a competing worker", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore({
      plan: plan({
        requiredWorkerVariant: "push",
        approvedCapabilities: ["notifications.web-push"],
      }),
      selection: selection("selected-only"),
      receipt: receipt({ "notifications.web-push": "sha256:x" }),
    });
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered).toEqual([]);
    expect(container.posted).toEqual([]);
    expect(workerStatus().transition).toEqual({
      from: "core-only",
      to: "push",
      status: "transition-required",
    });
  });

  it("transitionWorker unregisters the old script and registers the new one", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore({
      plan: plan({
        requiredWorkerVariant: "push",
        approvedCapabilities: ["notifications.web-push"],
      }),
      selection: selection("shell-only"),
      receipt: receipt({ "notifications.web-push": "sha256:x" }),
    });
    const { settled } = arm(container, store);
    await settled();
    await expect(transitionWorker()).resolves.toBe(true);
    expect(container.unregistered).toEqual([CORE_URL]);
    expect(container.registered.map((r) => r.url)).toEqual([PUSH_URL]);
    expect(workerStatus().transition).toBe(null);
    expect(workerStatus().variant).toBe("push");
    container.emit("controllerchange");
    expect(reloads).toBe(1);
    await expect(transitionWorker()).resolves.toBe(false);
  });

  it("reloads once on controllerchange, as the page always did", async () => {
    const container = new FakeContainer(null);
    const store = new FakeStore({
      plan: plan(),
      selection: null,
      receipt: null,
    });
    const { settled } = arm(container, store);
    await settled();
    container.emit("controllerchange");
    container.emit("controllerchange");
    expect(reloads).toBe(1);
  });
});

describe("plan assets and offline status", () => {
  const richPlan = plan({
    approvedModules: [
      "connectors.external/runtime",
      "notifications.web-push/worker",
    ],
  });

  it("posts nothing beyond the shell when the selection is shell-only", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore({
      plan: richPlan,
      selection: selection("shell-only"),
      receipt: null,
    });
    const { settled } = arm(container, store);
    await settled();
    expect(container.posted).toEqual([]);
    expect(workerStatus().offlineStatus).toBe("online-only");
  });

  it("asks the worker who it is, then posts module ids only — never a URL or a worker unit", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore({
      plan: richPlan,
      selection: selection("selected-only"),
      receipt: null,
    });
    const { settled } = arm(container, store);
    await settled();
    expect(container.posted).toEqual([{ type: "WORKER_HELLO" }]);
    container.emit("message", {
      type: "WORKER_INFO",
      releaseId: "r1abc",
      variant: "core-only",
      scopePath: "/OpenSesame/",
    });
    expect(container.posted[1]).toEqual({
      type: "PLAN_ASSETS",
      releaseId: "r1abc",
      planDigest: "sha256:plan1",
      moduleIds: ["connectors.external/runtime"],
    });
    expect(JSON.stringify(container.posted)).not.toMatch(/https?:|\.js/);
    expect(workerStatus()).toMatchObject({
      releaseId: "r1abc",
      offlineStatus: "saving",
    });

    container.emit("message", {
      type: "OFFLINE_READY",
      releaseId: "r1abc",
      planDigest: "sha256:plan1",
    });
    expect(workerStatus().offlineStatus).toBe("saved");

    // The same plan again is not re-posted; a changed one is.
    store.set({
      plan: richPlan,
      selection: selection("selected-only"),
      receipt: null,
    });
    await settled();
    expect(container.posted).toHaveLength(2);
    store.set({
      plan: plan({ approvedModules: [], planDigest: "sha256:plan2" }),
      selection: selection("selected-only"),
      receipt: null,
    });
    await settled();
    expect(container.posted[2]).toMatchObject({
      type: "PLAN_ASSETS",
      planDigest: "sha256:plan2",
      moduleIds: [],
    });
  });

  it("reports partial and storage-unavailable outcomes, and re-asks after a release mismatch", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore({
      plan: richPlan,
      selection: selection("selected-only"),
      receipt: null,
    });
    const { settled } = arm(container, store);
    await settled();
    container.emit("message", {
      type: "WORKER_INFO",
      releaseId: "r1abc",
      variant: "core-only",
      scopePath: "/OpenSesame/",
    });
    container.emit("message", {
      type: "OFFLINE_PARTIAL",
      releaseId: "r1abc",
      planDigest: "sha256:plan1",
      missing: 2,
    });
    expect(workerStatus().offlineStatus).toBe("partial");
    container.emit("message", {
      type: "OFFLINE_STORAGE_UNAVAILABLE",
      releaseId: "r1abc",
      planDigest: "sha256:plan1",
    });
    expect(workerStatus().offlineStatus).toBe("storage-unavailable");

    container.emit("message", {
      type: "PLAN_REJECTED",
      reason: "release-mismatch",
    });
    expect(workerStatus().offlineStatus).toBe("online-only");
    expect(workerStatus().diagnostics).toContain(
      "PLAN_REJECTED:release-mismatch",
    );
    expect(container.posted.at(-1)).toEqual({ type: "WORKER_HELLO" });
  });

  it("ignores messages that are not from the worker vocabulary", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore({
      plan: richPlan,
      selection: selection("selected-only"),
      receipt: null,
    });
    const { settled } = arm(container, store);
    await settled();
    container.emit("message", { type: "DELETE_EVERYTHING" });
    container.emit("message", { type: "WORKER_INFO" });
    expect(workerStatus().releaseId).toBe(null);
    expect(container.posted).toEqual([{ type: "WORKER_HELLO" }]);
  });
});
