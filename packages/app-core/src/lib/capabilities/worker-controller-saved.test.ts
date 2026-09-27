/**
 * What the worker saved for offline use, module by module (carried from
 * #470's cached status). The worker stages a plan all or nothing, so an
 * `OFFLINE_READY` for the plan the page posted means every module in it is
 * saved; the controller reports that set back to the store, which projects
 * it as `cached-offline` without resolving.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerStatus } from "./worker-controller.js";
import {
  CORE_URL,
  FakeContainer,
  FakeStore,
  arm,
  installSeams,
  plan,
  restoreSeams,
  selection,
} from "./worker/test-harness.js";

beforeEach(installSeams);
afterEach(restoreSeams);

const MODULES = [
  "connectors.external/runtime",
  "vault.passkey-records/runtime",
];

async function saving(
  delivery: "selected-only" | "shell-only" = "selected-only",
) {
  const container = new FakeContainer(CORE_URL);
  const store = new FakeStore({
    plan: plan({ approvedModules: MODULES }),
    selection: selection(delivery),
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
  return { container, store, settled };
}

describe("saved module ids", () => {
  it("are the posted plan's modules once the worker says that plan is ready", async () => {
    const { container, store } = await saving();
    expect(workerStatus().savedModuleIds).toEqual([]);
    container.emit("message", {
      type: "OFFLINE_READY",
      releaseId: "r1abc",
      planDigest: "sha256:plan1",
    });
    expect(workerStatus().savedModuleIds).toEqual(MODULES);
    expect(store.savedReports.at(-1)).toEqual(MODULES);
  });

  it("a readiness for another plan saves nothing new, and a partial save saves nothing", async () => {
    const { container, store } = await saving();
    container.emit("message", {
      type: "OFFLINE_PARTIAL",
      releaseId: "r1abc",
      planDigest: "sha256:plan1",
      missing: 1,
    });
    container.emit("message", {
      type: "OFFLINE_READY",
      releaseId: "r1abc",
      planDigest: "sha256:some-other-plan",
    });
    expect(workerStatus().offlineStatus).toBe("saved");
    expect(workerStatus().savedModuleIds).toEqual([]);
    expect(store.savedReports.every((r) => r.length === 0)).toBe(true);
  });

  it("another release starts from nothing saved", async () => {
    const { container } = await saving();
    container.emit("message", {
      type: "OFFLINE_READY",
      releaseId: "r1abc",
      planDigest: "sha256:plan1",
    });
    container.emit("message", {
      type: "WORKER_INFO",
      releaseId: "r2def",
      variant: "core-only",
      scopePath: "/OpenSesame/",
    });
    expect(workerStatus().savedModuleIds).toEqual([]);
  });

  it("switching delivery to shell-only claims nothing saved", async () => {
    const { container, store, settled } = await saving();
    container.emit("message", {
      type: "OFFLINE_READY",
      releaseId: "r1abc",
      planDigest: "sha256:plan1",
    });
    store.set({
      plan: plan({ approvedModules: MODULES }),
      selection: selection("shell-only"),
      receipt: null,
    });
    await settled();
    expect(workerStatus()).toMatchObject({
      offlineStatus: "online-only",
      savedModuleIds: [],
    });
    expect(store.savedReports.at(-1)).toEqual([]);
  });
});
