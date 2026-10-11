/** @vitest-environment node */
/**
 * The MQTT carrier's client options: no retry of a first connection,
 * reconnecting only once a broker has answered, and the page's own timers
 * rather than a worker from a Blob URL; a failed subscription closes
 * the client rather than leaking it. The connector is injected — the real
 * client against a broker that hangs up is `mqtt.reconnect.test.ts`.
 */

import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { type Connect, mqttCarrier } from "./mqtt.js";

type Options = {
  reconnectPeriod?: number;
  username?: string;
  timerVariant?: string;
};
type Call = {
  url: string;
  options: Options;
  allowRetries: boolean | undefined;
};

/** A client that connects, and whose subscription answers as told. */
function broker(subscribe: () => Promise<string[]>) {
  const client = {
    options: { reconnectPeriod: 0 },
    subscribeAsync: vi.fn(subscribe),
    publishAsync: vi.fn(async () => {}),
    endAsync: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  };
  const calls: Call[] = [];
  const connect: Connect = overlapCast(
    async (url: string, options: Options, allowRetries?: boolean) => {
      calls.push({ url, options: { ...options }, allowRetries });
      return client;
    },
  );
  return { client, calls, connect };
}

describe("mqttCarrier", () => {
  it("asks for a rejection on failure, holds reconnecting until connected, then allows it", async () => {
    const { client, calls, connect } = broker(async () => []);
    const carrier = await mqttCarrier(
      { kind: "mqtt", url: "wss://broker.example.test", username: "u" },
      "topic",
      connect,
    );
    expect(calls).toEqual([
      {
        url: "wss://broker.example.test",
        // Nothing reconnects while the first connection is in flight, and
        // the timers are the page's: no Blob-URL worker for WebKit to lose.
        options: expect.objectContaining({
          reconnectPeriod: 0,
          username: "u",
          timerVariant: "native",
        }),
        allowRetries: false,
      },
    ]);
    expect(client.options.reconnectPeriod).toBe(3000);
    expect(client.subscribeAsync).toHaveBeenCalledWith(
      "opensesame/live/topic",
      {
        qos: 1,
      },
    );
    carrier.close();
    expect(client.endAsync).toHaveBeenCalledWith(true);
  });

  it("ends a client whose subscription fails, and passes the failure on", async () => {
    const { client, connect } = broker(async () => {
      throw new Error("not authorized");
    });
    await expect(
      mqttCarrier(
        { kind: "mqtt", url: "wss://broker.example.test" },
        "t",
        connect,
      ),
    ).rejects.toThrow("not authorized");
    expect(client.endAsync).toHaveBeenCalledWith(true);
    expect(client.options.reconnectPeriod).toBe(0);
  });
});
