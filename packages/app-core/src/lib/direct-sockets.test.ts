import type { JsonValue } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import {
  directSocketsAvailability,
  multicastDirectSocketsAvailable,
  openTcpSocket,
  openUdpSocket,
} from "./direct-sockets.js";

describe("Direct Sockets adapter", () => {
  it("is unavailable outside an IWA", () => {
    vi.stubGlobal("location", { protocol: "https:" });
    expect(directSocketsAvailability()).toBe("unavailable");
  });

  it("opens a TCP socket in an IWA and validates its port", async () => {
    const opened = { readable: {}, writable: {} };
    const calls: JsonValue[][] = [];
    class FakeTcp {
      readonly opened = Promise.resolve(opened);
      constructor(...args: JsonValue[]) {
        calls.push(args);
      }
      close(): void {}
    }
    vi.stubGlobal("location", { protocol: "isolated-app:" });
    vi.stubGlobal("TCPSocket", FakeTcp);
    const result = await openTcpSocket("127.0.0.1", 22, { noDelay: true });
    expect(result.opened).toBe(opened);
    expect(calls).toEqual([["127.0.0.1", 22, { noDelay: true }]]);
    await expect(openTcpSocket("127.0.0.1", 0)).rejects.toThrow(
      /outside 1-65535/,
    );
  });

  it("binds UDP and reports the multicast constructor surface", async () => {
    const opened = { readable: {}, writable: {}, localPort: 5353 };
    class FakeUdp {
      readonly opened = Promise.resolve(opened);
      close(): void {}
    }
    vi.stubGlobal("location", { protocol: "isolated-app:" });
    vi.stubGlobal("UDPSocket", FakeUdp);
    await expect(
      openUdpSocket({ localAddress: "0.0.0.0", localPort: 5353 }),
    ).resolves.toMatchObject({ opened });
    expect(multicastDirectSocketsAvailable()).toBe(true);
  });
});
