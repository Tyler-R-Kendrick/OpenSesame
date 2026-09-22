import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { workerStatus } from "./worker-controller.js";

beforeEach(installSeams);
afterEach(restoreSeams);

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
