/**
 * Local Peer-to-Peer (WICG draft), the browser-managed way to discover,
 * authenticate and connect to a peer on the local network. It is not a raw
 * socket API: the user agent discovers, authenticates and grants a peer, then
 * exposes a QUIC-backed connection and data channels.
 *
 * The constructors are not in the DOM lib yet. The adapter only exposes what
 * the session layer needs; the session still encrypts its own payload and
 * still treats a peer as untrusted.
 */
import { type ChannelMessage, readChannelMessage } from "./live/messages.js";
import { FRAME_BYTES, Inbox, type LiveChannel } from "./live/p2p.js";

type Lp2pDataChannel = {
  readonly label: string;
  readonly protocol: string;
  readonly id: number | null;
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  send(data: string | Blob | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  addEventListener(
    type: "open" | "close" | "error",
    listener: () => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
};
type Lp2pConnection = {
  /** Draft implementations differ; close when the platform provides it. */
  close?(): void;
  createDataChannel(
    label: string,
    options?: {
      protocol?: string;
      id?: number;
    },
  ): Lp2pDataChannel;
  addEventListener(
    type: "datachannel",
    listener: (event: { channel: Lp2pDataChannel }) => void,
  ): void;
};
type Lp2pReceiver = {
  onconnection: ((event: { connection: Lp2pConnection }) => void) | null;
  start(): Promise<void>;
  /** Stop advertising and accepting new peers, when the draft exposes it. */
  stop?(): void | Promise<void>;
};
type Lp2pRequest = { start(): Promise<Lp2pConnection> };

type LocalP2PHost = {
  LP2PReceiver?: new (options?: { nickname?: string }) => Lp2pReceiver;
  LP2PRequest?: new (options?: { nickname?: string }) => Lp2pRequest;
};

function host(): LocalP2PHost {
  return globalThis as LocalP2PHost;
}

/** Whether this secure context exposes the draft Local P2P constructors. */
export function localP2PAvailable(): boolean {
  if (globalThis.isSecureContext !== true) return false;
  return (
    typeof host().LP2PReceiver === "function" &&
    typeof host().LP2PRequest === "function"
  );
}

/** Start advertising; the user agent owns discovery and the grant prompt. */
export async function startLocalPeerReceiver(options?: {
  nickname?: string;
  onConnection?: (connection: Lp2pConnection) => void;
}): Promise<{ receiver: Lp2pReceiver; stop(): void }> {
  const Ctor = host().LP2PReceiver;
  if (Ctor === undefined) throw new Error("Local Peer-to-Peer is unavailable");
  const receiver = new Ctor(
    options?.nickname === undefined ? {} : { nickname: options.nickname },
  );
  const accepted = new Set<Lp2pConnection>();
  receiver.onconnection = (event) => {
    accepted.add(event.connection);
    options?.onConnection?.(event.connection);
  };
  await receiver.start();
  let stopped = false;
  return {
    receiver,
    stop: () => {
      if (stopped) return;
      stopped = true;
      receiver.onconnection = null;
      void receiver.stop?.();
      for (const connection of accepted) connection.close?.();
      accepted.clear();
    },
  };
}

/** Ask the user agent for a local peer; its native UI performs the grant. */
export async function requestLocalPeer(options?: {
  nickname?: string;
}): Promise<Lp2pConnection> {
  const Ctor = host().LP2PRequest;
  if (Ctor === undefined) throw new Error("Local Peer-to-Peer is unavailable");
  return await new Ctor(
    options?.nickname === undefined ? {} : { nickname: options.nickname },
  ).start();
}

/**
 * A live-session channel over one LP2P data channel. The frame limits and
 * message reader are the same as WebRTC's: the transport changes, the
 * protocol does not.
 */
export class LocalPeerChannel implements LiveChannel {
  readonly #inbox = new Inbox();
  #open = false;

  constructor(private readonly channel: Lp2pDataChannel) {
    channel.addEventListener("open", () => {
      this.#open = true;
    });
    channel.addEventListener("close", () => {
      this.#open = false;
    });
    channel.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = readChannelMessage(event.data);
      if (message) this.#inbox.deliver(message);
    });
  }

  send(message: ChannelMessage): boolean {
    if (!this.#open) return false;
    const frame = JSON.stringify(message);
    if (new TextEncoder().encode(frame).length > FRAME_BYTES) return false;
    try {
      this.channel.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.#inbox.read(handler);
  }

  onClose(handler: () => void): void {
    this.channel.addEventListener("close", () => handler());
  }

  close(): void {
    this.channel.close();
  }
}

/** Open a named data channel on an LP2P connection. */
export function openLocalPeerChannel(
  connection: Lp2pConnection,
  label = "osm-live-v1",
  options?: { protocol?: string; id?: number },
): LocalPeerChannel {
  return new LocalPeerChannel(connection.createDataChannel(label, options));
}
