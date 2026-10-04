/**
 * A replacement the browser leaves waiting: Chrome, when another tab restarts
 * the old worker as it is being stopped, never completes the activation. The
 * controller asks for the script again under a fresh URL, and comes back to
 * one it gave up on (`worker/activation.ts`, `worker/recover.ts`). Walked
 * against a fake container that wedges the way Chrome does.
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

const approved = () => ({
  plan: pushPlan,
  selection: selection("shell-only"),
  receipt: receipt("notifications.web-push"),
});

/** Let the controller reach its next wait, then let the nudge interval pass. */
async function pump(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    env.elapse(5_000);
  }
}

describe("a replacement the browser leaves waiting (another tab restarted the old worker)", () => {
  it("is asked for again under a fresh URL, and then holds the scope", async () => {
    const container = new FakeContainer(CORE_URL);
    container.wedges = 1;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    const done = settled();
    await pump(3);
    await done;
    expect(container.registered.map((r) => r.url)).toEqual([
      PUSH_URL,
      `${PUSH_URL}?r=1`,
    ]);
    expect(container.unregistered).toEqual([]);
    expect(workerStatus().variant).toBe("push");
    expect(workerStatus().pendingVariant).toBe(null);
    expect(workerStatus().diagnostics).not.toContain("WORKER_INSTALL_FAILED");
  });

  it("keeps asking, a new URL each time, until one activates", async () => {
    const container = new FakeContainer(CORE_URL);
    container.wedges = 3;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    const done = settled();
    await pump(8);
    await done;
    expect(container.registered.map((r) => r.url)).toEqual([
      PUSH_URL,
      `${PUSH_URL}?r=1`,
      `${PUSH_URL}?r=2`,
      `${PUSH_URL}?r=3`,
    ]);
    expect(workerStatus().variant).toBe("push");
  });

  it("does not ask again while the worker is merely slow to install", async () => {
    const container = new FakeContainer(CORE_URL);
    container.installOutcome = "hang";
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    const done = settled();
    await pump(3);
    expect(container.registered).toHaveLength(1);
    container.finishInstall("activate");
    await done;
    expect(workerStatus().variant).toBe("push");
  });

  it("gives up at the bound, leaving the worker in charge, if it never activates", async () => {
    const container = new FakeContainer(CORE_URL);
    container.wedges = 1000;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    const done = settled();
    await pump(4);
    env.elapse();
    await pump(2);
    await done;
    expect(container.activeScript).toBe(CORE_URL);
    expect(workerStatus().variant).toBe("core-only");
    expect(workerStatus().diagnostics).toContain("WORKER_INSTALL_FAILED");
  });

  it("is not held past the bound by a script fetch that never answers", async () => {
    const container = new FakeContainer(CORE_URL);
    container.wedges = 1000;
    container.hangRegisterFrom = 2;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    const done = settled();
    await pump(2);
    expect(container.registered).toHaveLength(2);
    env.elapse();
    await expect(
      Promise.race([done.then(() => "settled"), pump(2).then(() => "held")]),
    ).resolves.toBe("settled");
    expect(workerStatus().variant).toBe("core-only");
    expect(workerStatus().diagnostics).toContain("WORKER_INSTALL_FAILED");
  });

  it("comes back to a replacement it gave up on, fresh, and then holds the scope", async () => {
    const container = new FakeContainer(CORE_URL);
    container.wedges = 1000;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    let done = settled();
    await pump(4);
    env.elapse();
    await pump(2);
    await done;
    expect(container.activeScript).toBe(CORE_URL);
    const gaveUp = container.registered.length;
    const last = container.registered[gaveUp - 1]?.url ?? "";
    // The browser is well again; the page was never reloaded, nor the plan changed.
    container.wedges = 0;
    env.elapse();
    done = settled();
    await pump(2);
    await done;
    expect(container.registered).toHaveLength(gaveUp + 1);
    const again = container.registered[gaveUp]?.url ?? "";
    expect(again).not.toBe(last);
    expect(new URL(again).pathname).toBe(new URL(PUSH_URL).pathname);
    expect(container.unregistered).toEqual([]);
    expect(workerStatus().variant).toBe("push");
    expect(workerStatus().pendingVariant).toBe(null);
  });

  it("comes back a bounded number of times, and never in a tight loop", async () => {
    const container = new FakeContainer(CORE_URL);
    container.wedges = 1_000_000;
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    let done = settled();
    await pump(4);
    env.elapse();
    await pump(2);
    await done;
    let counted = container.registered.length;
    const registrations: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      // Nothing changes until the look-again timer runs.
      await pump(2);
      expect(container.registered).toHaveLength(counted);
      env.elapse();
      done = settled();
      await pump(4);
      env.elapse();
      await pump(2);
      await done;
      registrations.push(container.registered.length - counted);
      counted = container.registered.length;
    }
    // Three recoveries each begin with one fresh script; then it is left alone.
    expect(registrations.slice(0, 3).every((n) => n >= 1)).toBe(true);
    expect(registrations.slice(3)).toEqual([0, 0, 0]);
    expect(container.activeScript).toBe(CORE_URL);
  });

  it("counts a script asked for again as the same variant, and registers nothing at the next boot", async () => {
    const container = new FakeContainer(`${PUSH_URL}?r=2`);
    const store = new FakeStore(approved());
    const { settled } = arm(container, store);
    await settled();
    expect(container.registered).toEqual([]);
    expect(workerStatus().variant).toBe("push");
  });
});
