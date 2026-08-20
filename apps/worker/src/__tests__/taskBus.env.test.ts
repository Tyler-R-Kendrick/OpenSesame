import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { natsSeams } from "../nats.js";
import {
  MemoryTaskBus,
  NatsJetStreamTaskBus,
  createTaskBusFromEnv,
  eventSubject,
  resolveTaskBusBackend,
} from "../taskBus.js";

const connect = vi.fn();

beforeEach(() => {
  natsSeams.connect = overlapCast(connect);
  natsSeams.StringCodec = overlapCast(() => ({
    encode: (value: string) => new TextEncoder().encode(value),
    decode: (value: Uint8Array) => new TextDecoder().decode(value),
  }));
});

describe("resolveTaskBusBackend variants", () => {
  it("accepts the documented memory spellings", () => {
    expect(resolveTaskBusBackend({ OPENSESAME_TASKBUS: "memory" })).toBe(
      "memory",
    );
    expect(resolveTaskBusBackend({ OPENSESAME_TASKBUS: "inmemory" })).toBe(
      "memory",
    );
    expect(resolveTaskBusBackend({ OPENSESAME_TASKBUS: "in-memory" })).toBe(
      "memory",
    );
  });

  it("accepts jetstream as an alias for nats, case- and space-insensitively", () => {
    expect(
      resolveTaskBusBackend({
        OPENSESAME_TASKBUS: " JetStream ",
        NATS_URL: "nats://127.0.0.1:4222",
      }),
    ).toBe("nats");
    expect(
      resolveTaskBusBackend({
        OPENSESAME_TASKBUS: "NATS",
        NATS_URL: "nats://127.0.0.1:4222",
      }),
    ).toBe("nats");
  });

  it("rejects unknown backends with a helpful message", () => {
    expect(() =>
      resolveTaskBusBackend({ OPENSESAME_TASKBUS: "kafka" }),
    ).toThrow(/unknown OPENSESAME_TASKBUS=kafka; expected memory\|nats/);
  });

  it("lets an explicit memory selection win over a set NATS_URL", () => {
    expect(
      resolveTaskBusBackend({
        OPENSESAME_TASKBUS: "memory",
        NATS_URL: "nats://127.0.0.1:4222",
      }),
    ).toBe("memory");
  });
});

describe("createTaskBusFromEnv", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("builds an in-memory bus without opening sockets", async () => {
    const bus = await createTaskBusFromEnv({});
    expect(bus).toBeInstanceOf(MemoryTaskBus);
    expect(connect).not.toHaveBeenCalled();
  });

  it("builds a JetStream bus from NATS_URL alone", async () => {
    connect.mockResolvedValue({
      drain: vi.fn().mockResolvedValue(undefined),
      jetstreamManager: vi.fn().mockResolvedValue({
        streams: {
          info: vi.fn().mockResolvedValue({ name: "OPENSESAME_EVENTS" }),
        },
      }),
      jetstream: vi.fn().mockReturnValue({ publish: vi.fn() }),
    });

    const bus = await createTaskBusFromEnv({
      NATS_URL: "nats://127.0.0.1:4222",
    });
    expect(bus).toBeInstanceOf(NatsJetStreamTaskBus);
    expect(connect).toHaveBeenCalledWith({
      servers: "nats://127.0.0.1:4222",
      name: "opensesame-worker",
    });
  });
});

describe("NatsJetStreamTaskBus.close", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("drains the connection", async () => {
    const drain = vi.fn().mockResolvedValue(undefined);
    connect.mockResolvedValue({
      drain,
      jetstreamManager: vi.fn().mockResolvedValue({
        streams: {
          info: vi.fn().mockResolvedValue({ name: "OPENSESAME_EVENTS" }),
        },
      }),
      jetstream: vi.fn().mockReturnValue({ publish: vi.fn() }),
    });

    const bus = await NatsJetStreamTaskBus.connect("nats://127.0.0.1:4222");
    await bus.close();
    expect(drain).toHaveBeenCalledTimes(1);
  });
});

describe("eventSubject", () => {
  it("strips a leading dot from the event type", () => {
    expect(eventSubject(".principal.created")).toBe(
      "opensesame.events.principal.created",
    );
  });
});
