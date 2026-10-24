import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import type { ChannelMessage } from "./live/messages.js";
import {
  LocalPeerChannel,
  localP2PAvailable,
  openLocalPeerChannel,
  requestLocalPeer,
  startLocalPeerReceiver,
} from "./local-p2p.js";

function channel() {
  const listeners = new Map<string, Array<(event?: BoundaryValue) => void>>();
  return {
    label: "test",
    protocol: "",
    id: null,
    readyState: "open" as const,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener(type: string, listener: (event?: BoundaryValue) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit(type: string, event?: BoundaryValue) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

describe("Local Peer-to-Peer adapter", () => {
  it("is unavailable outside a secure LP2P context", () => {
    vi.stubGlobal("isSecureContext", true);
    expect(localP2PAvailable()).toBe(false);
  });

  it("stops advertising and closes every accepted peer on stop", async () => {
    const connection = {
      createDataChannel: vi.fn(),
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    class Receiver {
      onconnection: ((event: { connection: unknown }) => void) | null = null;
      stop = vi.fn(async () => undefined);
      start = vi.fn(async () => undefined);
    }
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("LP2PReceiver", Receiver);
    vi.stubGlobal(
      "LP2PRequest",
      class {
        start = vi.fn(async () => connection);
      },
    );
    const seen = vi.fn();
    const handle = await startLocalPeerReceiver({ onConnection: seen });
    // The receiver is the fake class registered above.
    const receiver: InstanceType<typeof Receiver> = overlapCast(
      handle.receiver,
    );
    receiver.onconnection?.({ connection });
    expect(seen).toHaveBeenCalledWith(connection);
    handle.stop();
    handle.stop();
    expect(receiver.stop).toHaveBeenCalledOnce();
    expect(receiver.onconnection).toBeNull();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("starts a receiver and requests a peer", async () => {
    const connection = {
      createDataChannel: vi.fn(),
      addEventListener: vi.fn(),
    };
    const start = vi.fn(async () => undefined);
    const request = vi.fn(async () => connection);
    class Receiver {
      onconnection: ((event: { connection: unknown }) => void) | null = null;
      start = start;
    }
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("LP2PReceiver", Receiver);
    vi.stubGlobal(
      "LP2PRequest",
      class {
        start = request;
      },
    );
    const receiver = await startLocalPeerReceiver({ nickname: "desk" });
    expect(start).toHaveBeenCalledOnce();
    await expect(requestLocalPeer({ nickname: "phone" })).resolves.toBe(
      connection,
    );
    receiver.stop();
  });

  it("bridges a data channel to the live-session frame protocol", () => {
    const raw = channel();
    // The fake carries every member the bridge touches.
    const native: ConstructorParameters<typeof LocalPeerChannel>[0] =
      overlapCast(raw);
    const bridge = new LocalPeerChannel(native);
    raw.emit("open");
    const seen: ChannelMessage[] = [];
    bridge.onMessage((message) => seen.push(message));
    const message: ChannelMessage = { t: "hello" };
    expect(bridge.send(message)).toBe(true);
    expect(raw.send).toHaveBeenCalledWith(JSON.stringify(message));
    raw.emit("message", { data: JSON.stringify(message) });
    expect(seen).toEqual([message]);
    bridge.close();
    expect(raw.close).toHaveBeenCalledOnce();
  });

  it("opens a labelled data channel", () => {
    const raw = channel();
    const connection = { createDataChannel: vi.fn(() => raw) };
    // The fake carries the one member opening a channel touches.
    const native: Parameters<typeof openLocalPeerChannel>[0] =
      overlapCast(connection);
    expect(openLocalPeerChannel(native)).toBeInstanceOf(LocalPeerChannel);
    expect(connection.createDataChannel).toHaveBeenCalledWith(
      "osm-live-v1",
      undefined,
    );
  });
});
