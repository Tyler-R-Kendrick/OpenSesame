import { describe, expect, it, vi } from "vitest";
import {
  LocalPeerChannel,
  localP2PAvailable,
  openLocalPeerChannel,
  requestLocalPeer,
  startLocalPeerReceiver,
} from "./local-p2p.js";

function channel() {
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  return {
    label: "test",
    protocol: "",
    id: null,
    readyState: "open" as const,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener(type: string, listener: (event?: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit(type: string, event?: unknown) {
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
    const receiver = handle.receiver as InstanceType<typeof Receiver>;
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
    const bridge = new LocalPeerChannel(raw as never);
    raw.emit("open");
    const seen: unknown[] = [];
    bridge.onMessage((message) => seen.push(message));
    const message = { t: "hello" };
    expect(bridge.send(message as never)).toBe(true);
    expect(raw.send).toHaveBeenCalledWith(JSON.stringify(message));
    raw.emit("message", { data: JSON.stringify(message) });
    expect(seen).toEqual([message]);
    bridge.close();
    expect(raw.close).toHaveBeenCalledOnce();
  });

  it("opens a labelled data channel", () => {
    const raw = channel();
    const connection = { createDataChannel: vi.fn(() => raw) };
    expect(openLocalPeerChannel(connection as never)).toBeInstanceOf(
      LocalPeerChannel,
    );
    expect(connection.createDataChannel).toHaveBeenCalledWith(
      "osm-live-v1",
      undefined,
    );
  });
});
