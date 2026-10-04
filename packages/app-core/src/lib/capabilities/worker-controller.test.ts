import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKER_GRAPH_UNAVAILABLE,
  transitionWorker,
  workerStatus,
} from "./worker-controller.js";
import {
  CORE_ONLY_DISTRIBUTION,
  CORE_URL,
  FakeContainer,
  FakeStore,
  PUSH_URL,
  arm,
  env,
  installSeams,
  plan,
  receipt,
  restoreSeams,
  selection,
} from "./worker/test-harness.js";

beforeEach(installSeams);
afterEach(restoreSeams);

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
        options: {
          type: "classic",
          updateViaCache: "none",
          scope: "https://example.test/OpenSesame/",
        },
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
    env.isolated = true;
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
      receipt: receipt("vault.passwords", "d"),
    });
    await settled();
    expect(container.registered).toEqual([]);
  });

  it("registers it once the capability is approved and in the receipt", async () => {
    const container = new FakeContainer(null);
    const store = new FakeStore({
      plan: pushPlan,
      selection: selection("shell-only"),
      receipt: receipt("notifications.web-push"),
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
      receipt: receipt("notifications.web-push"),
    });
    const { settled } = arm(container, store, CORE_ONLY_DISTRIBUTION);
    await settled();
    expect(container.registered).toEqual([]);
    expect(workerStatus().diagnostics).toContain(WORKER_GRAPH_UNAVAILABLE);
    expect(workerStatus().requiredVariant).toBe("push");
  });
});

describe("transitions (PWA-02, PWA-06)", () => {
  const pushPlan = plan({
    requiredWorkerVariant: "push",
    approvedCapabilities: ["notifications.web-push"],
  });

  it("replaces the registered script in place once the variant is eligible (approval is the consent)", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore({
      plan: pushPlan,
      selection: selection("selected-only"),
      receipt: receipt("notifications.web-push"),
    });
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered.map((r) => r.url)).toEqual([PUSH_URL]);
    expect(container.unregistered).toEqual([]);
    expect(workerStatus().transition).toBe(null);
    expect(workerStatus().variant).toBe("push");
  });

  it("never replaces a worker for a variant the installation has not accepted", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore({
      plan: pushPlan,
      selection: selection("selected-only"),
      receipt: receipt("vault.passwords"),
    });
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered).toEqual([]);
    expect(workerStatus().transition).toBe(null);
    expect(workerStatus().variant).toBe(null);
  });

  it("transitionWorker has nothing to do when no change is pending", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore({
      plan: plan(),
      selection: null,
      receipt: null,
    });
    const { settled } = arm(container, store);
    await settled();
    await expect(transitionWorker()).resolves.toBe(false);
    expect(container.registered).toEqual([]);
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
    expect(env.reloads).toBe(1);
  });
});
