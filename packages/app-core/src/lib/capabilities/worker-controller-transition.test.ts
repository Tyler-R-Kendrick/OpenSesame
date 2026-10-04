/**
 * The controller against a fake `ServiceWorkerContainer`, walked the way a
 * person meets it: approve Push notifications on a device that already holds
 * the core worker, boot again with it approved, and take it away. What a
 * second tab of the same origin sees is `worker-controller-takeover.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kvDelete, kvGet, kvSet } from "../kv.js";
import {
  PUSH_PENDING_FORGET_KEY,
  PUSH_SUBSCRIPTION_KEY,
  pendingPushForgets,
} from "../web-push-ledger.js";
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

beforeEach(() => {
  installSeams();
  kvDelete(PUSH_SUBSCRIPTION_KEY);
  kvDelete(PUSH_PENDING_FORGET_KEY);
});
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

/** The page's first controller names its release, as a worker does on boot. */
const bootedUnder = (container: FakeContainer, releaseId = "rel-1") =>
  container.emit("message", { type: "WORKER_INFO", releaseId });

describe("approving Push notifications on a device that holds the core worker", () => {
  it("installs the push worker the moment the approval lands, and does not reload the page for it", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore(notApproved());
    const { settled } = arm(container, store);
    await settled();
    bootedUnder(container);
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
    expect(workerStatus().pendingVariant).toBe(null);
    expect(workerStatus().transition).toBe(null);

    // The new worker claims the page and says it is the release this page runs.
    container.emit("controllerchange");
    bootedUnder(container);
    expect(env.reloads).toBe(0);
  });

  it("stages the plan with the worker that took the page", async () => {
    const container = new FakeContainer(CORE_URL);
    const store = new FakeStore(notApproved());
    const { settled } = arm(container, store);
    await settled();
    bootedUnder(container);
    store.set(approved("selected-only", "sha256:plan2"));
    await settled();
    container.posted.length = 0;
    container.emit("controllerchange");
    expect(container.posted).toEqual([{ type: "WORKER_HELLO" }]);
    bootedUnder(container);
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
    // It is installing, not running: the status says so.
    expect(workerStatus().variant).toBe("core-only");
    expect(workerStatus().pendingVariant).toBe("push");
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

    // The next plan change tries again.
    container.registerFails = false;
    store.set(approved("shell-only", "sha256:plan2"));
    await settled();
    expect(container.registered).toHaveLength(2);
    expect(workerStatus().variant).toBe("push");
  });
});

describe("a replacement that does not take the scope", () => {
  it("is not reported as running while it installs, and is once it activates", async () => {
    const container = new FakeContainer(CORE_URL);
    container.installOutcome = "hang";
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    const done = settled();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workerStatus().variant).toBe("core-only");
    expect(workerStatus().pendingVariant).toBe("push");
    expect(workerStatus().transition?.status).toBe("transitioning");

    container.finishInstall("activate");
    await done;
    expect(workerStatus().variant).toBe("push");
    expect(workerStatus().pendingVariant).toBe(null);
    expect(workerStatus().transition).toBe(null);
  });

  it("leaves the worker in charge, and says so, when the install turns redundant", async () => {
    const container = new FakeContainer(CORE_URL);
    container.installOutcome = "redundant";
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    expect(container.activeScript).toBe(CORE_URL);
    expect(workerStatus().variant).toBe("core-only");
    expect(workerStatus().pendingVariant).toBe(null);
    expect(workerStatus().transition).toBe(null);
    expect(workerStatus().diagnostics).toContain("WORKER_INSTALL_FAILED");
    // Nothing is waiting for a claim that will never come: a genuine release
    // change still reloads.
    container.emit("controllerchange");
    expect(env.reloads).toBe(1);
  });

  it("gives up on an install that never settles, bounded", async () => {
    const container = new FakeContainer(CORE_URL);
    container.installOutcome = "hang";
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    const done = settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    env.elapse();
    await done;
    expect(workerStatus().variant).toBe("core-only");
    expect(workerStatus().pendingVariant).toBe(null);
    expect(workerStatus().diagnostics).toContain("WORKER_INSTALL_FAILED");
  });
});

describe("taking Push notifications away", () => {
  it("reverts to the core worker, never unregistering, drops the subscription the push worker held and retires its id", async () => {
    kvSet(PUSH_SUBSCRIPTION_KEY, "push_1");
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
    expect(container.pushUnsubscribed).toHaveLength(1);
    expect(workerStatus().variant).toBe("core-only");
    expect(workerStatus().requiredVariant).toBe("core-only");
    // The id leaves the live slot and waits to be forgotten by the Identity API.
    expect(kvGet(PUSH_SUBSCRIPTION_KEY)).toBeNull();
    expect(pendingPushForgets()).toEqual(["push_1"]);
  });

  it("drops the subscription only once the core worker really holds the scope", async () => {
    kvSet(PUSH_SUBSCRIPTION_KEY, "push_1");
    const container = new FakeContainer(PUSH_URL);
    container.holdsPushSubscription = true;
    container.installOutcome = "hang";
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    store.set(notApproved("sha256:plan2"));
    const done = settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.pushUnsubscribed).toEqual([]);
    expect(kvGet(PUSH_SUBSCRIPTION_KEY)).toBe("push_1");
    container.finishInstall("activate");
    await done;
    expect(container.pushUnsubscribed).toHaveLength(1);
    expect(pendingPushForgets()).toEqual(["push_1"]);
  });

  it("leaves the subscription, the id and the worker alone when the core worker could not be installed", async () => {
    kvSet(PUSH_SUBSCRIPTION_KEY, "push_1");
    const container = new FakeContainer(PUSH_URL);
    container.holdsPushSubscription = true;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    container.installOutcome = "redundant";
    store.set(notApproved("sha256:plan2"));
    await settled();
    expect(container.pushUnsubscribed).toEqual([]);
    expect(container.activeScript).toBe(PUSH_URL);
    expect(kvGet(PUSH_SUBSCRIPTION_KEY)).toBe("push_1");
    expect(pendingPushForgets()).toEqual([]);
  });
});
