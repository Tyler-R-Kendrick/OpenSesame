import { afterEach, describe, expect, it, vi } from "vitest";

const connect = vi.hoisted(() => vi.fn());
const jetstreamManager = vi.hoisted(() => vi.fn());
const jetstream = vi.hoisted(() => vi.fn());

vi.mock("nats", () => ({
  connect,
  StringCodec: () => ({
    encode: (value: string) => new TextEncoder().encode(value),
    decode: (value: Uint8Array) => new TextDecoder().decode(value),
  }),
}));

import { NatsJetStreamTaskBus } from "../taskBus.js";

describe("NatsJetStreamTaskBus", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("fails loudly when OPENSESAME_EVENTS stream is missing", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    connect.mockResolvedValue({
      close,
      jetstreamManager: jetstreamManager.mockResolvedValue({
        streams: {
          info: vi.fn().mockRejectedValue(new Error("stream not found")),
        },
      }),
      jetstream: jetstream.mockReturnValue({}),
    });

    await expect(
      NatsJetStreamTaskBus.connect("nats://127.0.0.1:4222"),
    ).rejects.toThrow(/JetStream stream OPENSESAME_EVENTS missing/);
    expect(close).toHaveBeenCalled();
  });

  it("publishes via JetStream when stream exists", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    connect.mockResolvedValue({
      drain: vi.fn().mockResolvedValue(undefined),
      jetstreamManager: jetstreamManager.mockResolvedValue({
        streams: {
          info: vi.fn().mockResolvedValue({ name: "OPENSESAME_EVENTS" }),
        },
      }),
      jetstream: jetstream.mockReturnValue({ publish }),
    });

    const bus = await NatsJetStreamTaskBus.connect("nats://127.0.0.1:4222");
    await bus.publish({
      id: "e1",
      specversion: "1.0",
      source: "test",
      type: "principal.created",
      time: "2026-08-17T00:00:00Z",
      data: { ok: true },
    });
    expect(publish).toHaveBeenCalledWith(
      "opensesame.events.principal.created",
      expect.any(Uint8Array),
    );
  });
});
