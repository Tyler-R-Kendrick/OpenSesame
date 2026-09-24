import { afterEach, describe, expect, it } from "vitest";
import {
  clearFrozenIntent,
  getTaskContext,
  requireFrozenIntent,
  setTaskContext,
  updateTaskFromResponse,
} from "./task-context.js";

describe("task-context edges", () => {
  afterEach(() => {
    setTaskContext(null);
  });

  it("requireFrozenIntent returns the frozen intent when one is set", () => {
    const frozenIntent = {
      intentId: "i-1",
      intentDigest: "sha256:abc",
      operation: "read",
      resource: "r1",
      audience: "https://api.example.test",
      canonicalArguments: {},
    };
    setTaskContext({ taskRunId: "t-1", stateVersion: 1, frozenIntent });
    expect(requireFrozenIntent()).toEqual(frozenIntent);
  });

  it("ignores responses that do not describe a task state", () => {
    setTaskContext({ taskRunId: "t-1", stateVersion: 1 });

    updateTaskFromResponse({});
    updateTaskFromResponse({ task_run_id: "other" });
    updateTaskFromResponse({ state_version: 9 });

    expect(getTaskContext()).toEqual({ taskRunId: "t-1", stateVersion: 1 });
  });

  it("clearFrozenIntent is a no-op without an active task", () => {
    setTaskContext(null);
    expect(() => clearFrozenIntent()).not.toThrow();
    expect(getTaskContext()).toBeNull();
  });
});
