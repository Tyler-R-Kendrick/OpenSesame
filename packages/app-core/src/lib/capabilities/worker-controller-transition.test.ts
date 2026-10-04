/**
 * The controller against a fake `ServiceWorkerContainer`, walked the way a
 * person meets it: approve Push notifications on a device that already holds
 * the core worker, boot again with it approved, and take it away.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerStatus } from "./worker-controller.js";
import {
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

const pushPlan = plan({
  requiredWorkerVariant: "push",
  approvedCapabilities: ["notifications.web-push"],
  approvedModules: ["notifications.web-push/worker"],
});

const approved = (
  offline: "shell-only" | "selected-only" = "shell-only",
  planDigest = "sha256:plan1",
) => ({
  plan: { ...pushPlan, identity: { ...pushPlan.identity, planDigest } },
  selection: selection(offline),
  receipt: receipt("notifications.web-push"),
});

const notApproved = (planDigest = "sha256:plan1") => ({
  plan: plan({ planDigest }),
  selection: selection("shell-only"),
  receipt: receipt("vault.passwords"),
});

describe("approving Push notifications on a device that holds the core worker", () => {
  it("installs the push worker the moment the approval lands, without reloading the page", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore(notApproved());
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered).toEqual([]);
    expect(workerStatus().variant).toBe("core-only");

    store.set(approved("shell-only", "sha256:plan2"));
    await settled();

    expect(container.registered.map((r) => r.url)).toEqual([PUSH_URL]);
    expect(container.registered[0]?.options?.scope).toBe(
      "https://example.test/OpenSesame/",
    );
    expect(container.unregistered).toEqual([]);
    expect(workerStatus().variant).toBe("push");
    expect(workerStatus().transition).toBe(null);

    // The new worker claims the page: it keeps running, nothing is reloaded.
    container.emit("controllerchange");
    expect(env.reloads).toBe(0);
  });

  it("introduces the page to the worker that took it, and stages the plan again", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore(notApproved());
    const { settled } = arm(container, store);
    await settled();
    store.set(approved("selected-only", "sha256:plan2"));
    await settled();
    container.posted.length = 0;
    container.emit("controllerchange");
    expect(container.posted).toEqual([{ type: "WORKER_HELLO" }]);
    container.emit("message", { type: "WORKER_INFO", releaseId: "rel-1" });
    expect(container.posted.map((m) => m.type)).toEqual([
      "WORKER_HELLO",
      "PLAN_ASSETS",
    ]);
  });

  it("is idempotent: a store change while the replacement installs does not register it again", async () => {
    const container = new FakeContainer(CORE_URL);
    container.installingScript = PUSH_URL;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    store.set(approved("shell-only", "sha256:plan2"));
    await settled();
    expect(container.registered).toEqual([]);
    expect(workerStatus().transition).toBe(null);
    expect(workerStatus().variant).toBe("push");
  });

  it("is idempotent across boots: a device already on the push worker registers nothing", async () => {
    const container = new FakeContainer(PUSH_URL);
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    store.set(approved("shell-only", "sha256:plan2"));
    await settled();
    expect(container.registered).toEqual([]);
    expect(container.unregistered).toEqual([]);
    expect(workerStatus().variant).toBe("push");
  });

  it("installs it when the app boots with the capability already approved on the core worker", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered.map((r) => r.url)).toEqual([PUSH_URL]);
  });

  it("keeps the worker it has, and says why, when the new script is refused", async () => {
    const container = new FakeContainer(CORE_URL);
    container.registerFails = true;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    expect(container.unregistered).toEqual([]);
    expect(container.activeScript).toBe(CORE_URL);
    expect(workerStatus().transition).toBe(null);
    expect(workerStatus().variant).toBe("core-only");
    expect(workerStatus().diagnostics).toContain("WORKER_REGISTRATION_FAILED");

    // The next plan change tries again; the refused attempt left nothing
    // waiting for a claim, so a genuine release change still reloads.
    container.registerFails = false;
    store.set(approved("shell-only", "sha256:plan2"));
    await settled();
    expect(container.registered).toHaveLength(2);
    container.emit("controllerchange");
    expect(env.reloads).toBe(0);
  });

  it("still reloads for a new release after the variant change has settled", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    container.emit("controllerchange");
    expect(env.reloads).toBe(0);
    container.emit("controllerchange");
    container.emit("controllerchange");
    expect(env.reloads).toBe(1);
  });

  it("copes with the claim arriving before the registration call returns", async () => {
    const container = new FakeContainer(CORE_URL);
    container.claimOnRegister = true;
    const store = new FakeStore(approved("selected-only"));
    const { settled } = arm(container, store);
    await settled();
    expect(env.reloads).toBe(0);
    expect(container.registered.map((r) => r.url)).toEqual([PUSH_URL]);
    expect(workerStatus().transition).toBe(null);
  });
});

describe("taking Push notifications away", () => {
  it("reverts to the core worker, never unregistering, and drops the subscription the push worker held", async () => {
    const container = new FakeContainer(PUSH_URL);
    container.holdsPushSubscription = true;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered).toEqual([]);

    store.set(notApproved("sha256:plan2"));
    await settled();

    expect(container.registered.map((r) => r.url)).toEqual([CORE_URL]);
    expect(container.unregistered).toEqual([]);
    expect(container.pushUnsubscribed).toEqual([PUSH_URL]);
    expect(workerStatus().variant).toBe("core-only");
    expect(workerStatus().requiredVariant).toBe("core-only");
    container.emit("controllerchange");
    expect(env.reloads).toBe(0);
  });

  it("leaves the subscription and the worker alone when the core worker could not be installed", async () => {
    const container = new FakeContainer(PUSH_URL);
    container.holdsPushSubscription = true;
    container.registerFails = true;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    store.set(notApproved("sha256:plan2"));
    await settled();
    expect(container.pushUnsubscribed).toEqual([]);
    expect(container.activeScript).toBe(PUSH_URL);
  });
});
