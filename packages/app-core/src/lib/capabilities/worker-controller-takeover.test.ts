/**
 * What a change of controller means to a page (`worker/plan-sync.ts`
 * `onControllerChange`): a reload for a different release, none for another
 * variant of the release the page runs — in the tab that approved Push
 * notifications and, the case that mattered, in every other tab of the same
 * origin, which did nothing and must not lose its unlocked vault.
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
