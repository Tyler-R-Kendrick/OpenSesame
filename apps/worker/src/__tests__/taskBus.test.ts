import { describe, expect, it } from "vitest";
import {
  eventSubject,
  MemoryTaskBus,
  outboxToBusEvent,
  resolveTaskBusBackend,
} from "../taskBus.js";

describe("taskBus", () => {
  it("defaults to memory without NATS env", () => {
    expect(resolveTaskBusBackend({})).toBe("memory");
  });

  it("selects nats when NATS_URL is set", () => {
    expect(
      resolveTaskBusBackend({ NATS_URL: "nats://127.0.0.1:4222" }),
    ).toBe("nats");
  });

  it("requires NATS_URL for explicit nats", () => {
    expect(() => resolveTaskBusBackend({ OPENSESAME_TASKBUS: "nats" })).toThrow(
      /NATS_URL/,
    );
  });

  it("maps outbox rows to CloudEvents subjects under opensesame.events", () => {
    const event = outboxToBusEvent({
      id: "e1",
      eventType: "principal.created",
      aggregateType: "principal",
      aggregateId: "prn_1",
      payload: { ok: true },
      createdAt: new Date("2026-08-17T00:00:00Z"),
    });
    expect(eventSubject(event.type)).toBe(
      "opensesame.events.principal.created",
    );
  });

  it("memory bus records publishes", async () => {
    const bus = new MemoryTaskBus();
    await bus.publish({
      id: "1",
      specversion: "1.0",
      source: "test",
      type: "t",
      time: "2026-08-17T00:00:00Z",
      data: {},
    });
    expect(bus.published).toHaveLength(1);
  });
});
