import { isFunction } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import * as worker from "../index.js";

describe("worker public surface", () => {
  it("re-exports the cleanup, rotation and task bus APIs", () => {
    expect(isFunction(worker.runCleanupTick)).toBe(true);
    expect(isFunction(worker.startCleanupLoop)).toBe(true);
    expect(isFunction(worker.createFakeClock)).toBe(true);
    expect(isFunction(worker.consumeRotationEvents)).toBe(true);
    expect(isFunction(worker.InMemoryRotationBus)).toBe(true);
    expect(isFunction(worker.MemoryTaskBus)).toBe(true);
    expect(isFunction(worker.createTaskBusFromEnv)).toBe(true);
    expect(isFunction(worker.outboxToBusEvent)).toBe(true);
    expect(isFunction(worker.resolveTaskBusBackend)).toBe(true);
    expect(isFunction(worker.eventSubject)).toBe(true);
    expect(worker.EVENT_ROTATION_REQUESTED).toBe(
      "credential.rotation.requested",
    );
    expect(worker.EVENT_ROTATION_SUCCEEDED).toBe(
      "credential.rotation.succeeded",
    );
    expect(worker.EVENT_ROTATION_FAILED).toBe("credential.rotation.failed");
  });

  it("wires re-exported symbols to their implementations", () => {
    // A re-export that points at nothing still passes a typeof check; call
    // through the barrel to prove the binding.
    expect(worker.eventSubject("a.b")).toBe("opensesame.events.a.b");
    expect(worker.resolveTaskBusBackend({})).toBe("memory");
    expect(new worker.MemoryTaskBus().published).toEqual([]);
    expect(new worker.InMemoryRotationBus()).toBeDefined();
  });
});
