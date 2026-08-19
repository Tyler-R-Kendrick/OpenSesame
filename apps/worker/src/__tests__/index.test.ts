import { describe, expect, it } from "vitest";
import * as worker from "../index.js";

describe("worker public surface", () => {
  it("re-exports the cleanup, rotation and task bus APIs", () => {
    expect(typeof worker.runCleanupTick).toBe("function");
    expect(typeof worker.startCleanupLoop).toBe("function");
    expect(typeof worker.createFakeClock).toBe("function");
    expect(typeof worker.consumeRotationEvents).toBe("function");
    expect(typeof worker.InMemoryRotationBus).toBe("function");
    expect(typeof worker.MemoryTaskBus).toBe("function");
    expect(typeof worker.createTaskBusFromEnv).toBe("function");
    expect(typeof worker.outboxToBusEvent).toBe("function");
    expect(typeof worker.resolveTaskBusBackend).toBe("function");
    expect(typeof worker.eventSubject).toBe("function");
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
