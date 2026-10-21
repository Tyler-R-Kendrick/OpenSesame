/**
 * What a change of controller means to a page (`worker/plan-sync.ts`
 * `onControllerChange`): a reload for a different release, none for another
 * variant of the release the page runs — in the tab that approved Push
 * notifications and, the case that mattered, in every other tab of the same
 * origin, which did nothing and must not lose its unlocked vault.
 */

import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdDirtyEdit, registerDraftSaver } from "../dirty-edit.js";
import {
  forceSessionReload,
  noteShellLoaded,
  registerWorkerForPlan,
  reloadForStaleAsset,
  resetWorkerController,
  updateIsOwed,
  workerControllerSeams,
  workerControllerSettled,
  workerStatus,
} from "./worker-controller.js";
import {
  CORE_URL,
  DISTRIBUTION,
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

import type { PageToWorkerMessage } from "./worker/types.js";

beforeEach(installSeams);
afterEach(restoreSeams);

const store = () =>
  new FakeStore({
    plan: plan(),
    selection: selection("shell-only"),
    receipt: receipt("vault.passwords"),
  });

const info = (container: FakeContainer, releaseId: string) =>
  container.emit("message", { type: "WORKER_INFO", releaseId });

/** A tab that booted under `controller` and answered hello with `release`. */
async function tabBooted(controller: string, release = "rel-1") {
  const container = new FakeContainer(controller);
  const { settled } = arm(container, store());
  await settled();
  info(container, release);
  return container;
}

describe("a second tab, when another tab changes the variant", () => {
  it("neither reloads nor loses its page: the new worker says it is the same release", async () => {
    const container = await tabBooted(CORE_URL);
    expect(workerStatus().variant).toBe("core-only");

    // Another tab approved Push notifications; its worker claimed this tab.
    container.activeScript = PUSH_URL;
    container.posted.length = 0;
    container.emit("controllerchange");
    expect(env.reloads).toBe(0);
    expect(container.posted).toEqual([{ type: "WORKER_HELLO" }]);

    info(container, "rel-1");
    expect(env.reloads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // This tab's status follows what really runs.
    expect(workerStatus().variant).toBe("push");
    env.elapse();
    expect(env.reloads).toBe(0);
  });

  it("does the same when the other tab removes the capability", async () => {
    const container = await tabBooted(PUSH_URL);
    container.activeScript = CORE_URL;
    container.emit("controllerchange");
    info(container, "rel-1");
    env.elapse();
    expect(env.reloads).toBe(0);
  });

  it("reloads once for a genuinely new release", async () => {
    const container = await tabBooted(CORE_URL);
    container.emit("controllerchange");
    info(container, "rel-2");
    expect(env.reloads).toBe(1);
    container.emit("controllerchange");
    expect(env.reloads).toBe(1);
  });

  it("reloads when the worker that took the page does not answer in time", async () => {
    const container = await tabBooted(CORE_URL);
    container.emit("controllerchange");
    expect(env.reloads).toBe(0);
    env.elapse();
    expect(env.reloads).toBe(1);
  });

  it("reloads at once when the page never learned which release it runs", async () => {
    const container = new FakeContainer(null);
    const { settled } = arm(container, store());
    await settled();
    container.emit("controllerchange");
    expect(env.reloads).toBe(1);
  });

  it("does not leave a stale timeout to reload a page that already settled", async () => {
    const container = await tabBooted(CORE_URL);
    container.emit("controllerchange");
    info(container, "rel-1");
    env.elapse();
    expect(env.reloads).toBe(0);
  });
});

describe("an unsaved edit", () => {
  it("holds a new release until the edit is gone, then reloads once", async () => {
    const release = holdDirtyEdit("item");
    const container = await tabBooted(CORE_URL);
    container.emit("controllerchange");
    info(container, "rel-2");
    expect(env.reloads).toBe(0);
    expect(workerStatus().updateReady).toBe(true);
    release();
    expect(env.reloads).toBe(1);
    expect(workerStatus().updateReady).toBe(false);
  });

  it("drops a timeout once the same release answers", async () => {
    const release = holdDirtyEdit("item");
    const container = await tabBooted(CORE_URL);
    container.emit("controllerchange");
    env.elapse();
    expect(env.reloads).toBe(0);
    expect(updateIsOwed()).toBe(true);
    info(container, "rel-1");
    expect(env.reloads).toBe(0);
    expect(workerStatus().updateReady).toBe(false);
    release();
    expect(env.reloads).toBe(0);
  });

  it("still reloads when the page never learned its release", async () => {
    holdDirtyEdit("item");
    const container = new FakeContainer(null);
    const { settled } = arm(container, store());
    await settled();
    container.emit("controllerchange");
    expect(env.reloads).toBe(0);
    expect(workerStatus().updateReady).toBe(true);
    info(container, "rel-9");
    expect(env.reloads).toBe(0);
    expect(updateIsOwed()).toBe(true);
  });

  it("reloads on lock only when a release is waiting, and writes the draft first", async () => {
    forceSessionReload("lock");
    forceSessionReload("idle");
    expect(env.reloads).toBe(0);
    const order: string[] = [];
    registerDraftSaver("item", async () => {
      order.push("save");
      return true;
    });
    holdDirtyEdit("item");
    const container = await tabBooted(CORE_URL);
    container.emit("controllerchange");
    info(container, "rel-2");
    forceSessionReload("lock");
    expect(env.reloads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["save"]);
    expect(env.reloads).toBe(1);
  });

  it("reloads for a missing chunk even when no release is waiting, and only once", async () => {
    expect(await reloadForStaleAsset()).toBe(true);
    expect(env.reloads).toBe(1);
    expect(await reloadForStaleAsset()).toBe(false);
    expect(env.reloads).toBe(1);
    // A new document starts with a fresh controller. The shell then clears
    // the one-shot, so a later miss may reload again.
    noteShellLoaded();
    resetWorkerController();
    expect(await reloadForStaleAsset()).toBe(true);
    expect(env.reloads).toBe(2);
  });
});

describe("an isolated first claim with an executing-entry port proof", () => {
  async function fresh(
    prove: (
      worker: ServiceWorker,
      signal: AbortSignal,
    ) => Promise<string | null>,
    isolated = true,
  ) {
    env.isolated = isolated;
    const container = new FakeContainer(null);
    const original: ServiceWorker = overlapCast({
      scriptURL: CORE_URL,
      postMessage(message: PageToWorkerMessage) {
        container.posted.push(message);
      },
    });
    let current: ServiceWorker | null = null;
    Object.defineProperty(container, "controller", { get: () => current });
    workerControllerSeams.serviceWorkerContainer = () =>
      container.asContainer();
    registerWorkerForPlan(store(), {
      distribution: DISTRIBUTION,
      initialReleaseProof: prove,
    });
    await workerControllerSettled();
    current = original;
    container.emit("controllerchange");
    return {
      container,
      original,
      replace: () => {
        current = overlapCast({ scriptURL: PUSH_URL });
        container.emit("controllerchange");
      },
    };
  }

  it("keeps the executing entry alive, then still reloads for a different release", async () => {
    let captured: ServiceWorker | null = null;
    const lifetimes = new Set<AbortSignal>();
    const setup = await fresh(async (worker, lifetime) => {
      captured = worker;
      lifetimes.add(lifetime);
      return "rel-1";
    });
    await Promise.resolve();
    expect(env.reloads).toBe(0);
    expect(captured).toBe(setup.original);
    expect([...lifetimes][0]?.aborted).toBe(true);
    expect(workerStatus().releaseId).toBe("rel-1");
    expect(env.reloads).toBe(0);
    env.elapse();
    expect(env.reloads).toBe(0);
    setup.container.emit("controllerchange");
    expect(env.reloads).toBe(0);
    info(setup.container, "rel-2");
    expect(env.reloads).toBe(1);
  });

  it("does not infer a proof from a broadcast and closes a timed-out attempt", async () => {
    let answer: (release: string | null) => void = () => undefined;
    const lifetimes = new Set<AbortSignal>();
    const setup = await fresh((_worker, lifetime) => {
      lifetimes.add(lifetime);
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    info(setup.container, "rel-1");
    expect(workerStatus().releaseId).toBeNull();
    expect(env.reloads).toBe(0);
    env.elapse(1999);
    expect(env.reloads).toBe(0);
    env.elapse(2000);
    expect(env.reloads).toBe(1);
    expect([...lifetimes][0]?.aborted).toBe(true);
    answer("rel-1");
    await Promise.resolve();
    expect(workerStatus().releaseId).toBeNull();
    expect(env.reloads).toBe(1);
  });

  it("never adopts a replacement controller or the old port's later reply", async () => {
    let answer: (release: string | null) => void = () => undefined;
    const lifetimes = new Set<AbortSignal>();
    const setup = await fresh((_worker, lifetime) => {
      lifetimes.add(lifetime);
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    setup.replace();
    expect([...lifetimes][0]?.aborted).toBe(true);
    expect(env.reloads).toBe(1);
    answer("rel-1");
    await Promise.resolve();
    expect(workerStatus().releaseId).toBeNull();
  });

  it.each([null, "bad:release"])(
    "reloads for refused or malformed proof %s",
    async (value) => {
      await fresh(async () => value);
      await Promise.resolve();
      expect(env.reloads).toBe(1);
    },
  );

  it("retains immediate reload for a fresh page without header isolation", async () => {
    let calls = 0;
    await fresh(async () => {
      calls++;
      return "rel-1";
    }, false);
    expect(calls).toBe(0);
    expect(env.reloads).toBe(1);
  });
});
