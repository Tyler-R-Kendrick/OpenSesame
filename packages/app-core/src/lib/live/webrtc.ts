/**
 * WebRTC as a live session's transport (ADR 0150 §3–§6, ADR 0186): a
 * `PeerTransport` over one `RTCPeerConnection` and one ordered data channel.
 *
 * The joiner's page makes the offer and the owner's page answers it, each
 * session description being its side's handshake, sealed in a pairing code a
 * person passes on (`pairing.ts`). Candidates are gathered in full before a
 * description is sealed (no trickle), so the whole handshake is those two
 * codes, and each description is read strictly (`sdp.ts`) before the browser
 * is handed it.
 *
 * By default no ICE server is configured: no STUN or TURN, nobody else's
 * machine. The browsers offer their own host candidates and reach each
 * other directly — on the same network, or wherever a route between them
 * exists. The owner may add what bridges the rest (`PeerRouting`): address
 * hints for a tunnel (`candidates.ts`), STUN and TURN servers, relay only.
 *
 * `RTCPeerConnection` is the shell's to construct (`PeerFactory`): app-core
 * touches no browser global, and tests hand in a fake.
 */

import { isString } from "@opensesame/os-domain";
import { withAddressHints } from "./candidates.js";
import { type IceDiagnosticView, watchRtcIce } from "./ice-diagnostics.js";
import { type ChannelMessage, readChannelMessage } from "./messages.js";
import {
  type DialLink,
  FRAME_BYTES,
  Inbox,
  type LiveChannel,
  PAIRING_MS,
  type PeerLink,
  type PeerRouting,
  type PeerTransport,
  type TransportFactory,
} from "./p2p.js";
import type { IceServerSpec } from "./routes.js";
import { isDataChannelSdp } from "./sdp.js";

export type PeerFactory = (config: RTCConfiguration) => RTCPeerConnection;

const CHANNEL_LABEL = "osm-live-v1";
const GATHER_MS = 8000;
/** What a frame read from the channel may be at most, in characters. */
const FRAME_MAX = 1024 * 1024;

/** The servers as the browser takes them: no empty username or credential. */
export function rtcServers(servers: readonly IceServerSpec[]): RTCIceServer[] {
  return servers.map((server) => {
    const out: RTCIceServer = { urls: [...server.urls] };
    if (server.username) out.username = server.username;
    if (server.credential) out.credential = server.credential;
    return out;
  });
}

function rtcConfig(routing: PeerRouting): RTCConfiguration {
  assertRoutableIceServers(routing.servers);
  return {
    iceServers: rtcServers(routing.servers),
    iceTransportPolicy: routing.relay ? "relay" : "all",
  };
}

/**
 * STUN/TURN make the browser send packets to whatever host the URL names.
 * A link-supplied `stun:169.254.169.254` is an SSRF probe for cloud metadata,
 * and loopback/link-local targets are never a legitimate public ICE server.
 * Private LAN and tailnet ranges stay allowed: a self-hosted TURN server there
 * is the documented deployment.
 */
export function assertRoutableIceServers(
  servers: readonly Pick<IceServerSpec, "urls">[],
): void {
  for (const server of servers) {
    for (const raw of server.urls) {
      const match = /^(?:stuns?|turns?):(\[[^\]]+\]|[^:?]+)/iu.exec(raw);
      const host = match?.[1]?.replace(/^\[|\]$/gu, "").toLowerCase();
      if (!host || blockedIceHost(host)) {
        throw new Error(`ice_server_blocked:${raw}`);
      }
    }
  }
}

function blockedIceHost(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(host);
  const v4 = mapped?.[1] ?? host;
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.test(v4)) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 100 && b === 100 && v4.endsWith(".200"))
    );
  }
  const mappedHex =
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host) ??
    /^(?:0{1,4}:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  if (mappedHex?.[1] && mappedHex[2]) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    return blockedIceHost(
      `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
    );
  }
  return (
    host === "::" ||
    host === "::1" ||
    /^fe[89ab][0-9a-f]:/u.test(host) ||
    /^::1:/u.test(host)
  );
}

/**
 * The local description once gathering is done, or after `GATHER_MS`, with
 * this side's address hints.
 */
async function gathered(
  pc: RTCPeerConnection,
  routing: PeerRouting,
): Promise<string> {
  if (pc.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, GATHER_MS);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState !== "complete") return;
        clearTimeout(timer);
        resolve();
      });
    });
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error("no_local_description");
  return routing.relay
    ? sdp
    : withAddressHints(
        sdp,
        routing.addresses.length ? routing.addresses : ["127.0.0.1", "::1"],
      );
}

/**
 * A data channel carrying the protocol's messages, read strictly. It
 * listens from the moment the channel exists and holds what arrives until a
 * handler is set (`Inbox`).
 */
export class PeerChannel implements LiveChannel {
  readonly #inbox = new Inbox();

  constructor(private readonly channel: RTCDataChannel) {
    channel.addEventListener("message", (event: MessageEvent) => {
      const { data } = event;
      if (!isString(data) || data.length > FRAME_MAX) return;
      const message = readChannelMessage(data);
      if (message) this.#inbox.deliver(message);
    });
  }

  /**
   * Whether the frame went out: not while closed, never one over what a
   * message may weigh in bytes (`FRAME_BYTES`), and not if the browser refuses
   * it, which for a data channel is a throw, not a result.
   */
  send(message: ChannelMessage): boolean {
    if (this.channel.readyState !== "open") return false;
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

/** Resolves with the channel once it is open; rejects if it never opens. */
function opened(channel: RTCDataChannel): Promise<PeerChannel> {
  // Listening starts now, not at open (see `PeerChannel`).
  const peer = new PeerChannel(channel);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("channel_timeout")),
      PAIRING_MS,
    );
    const done = () => {
      clearTimeout(timer);
      resolve(peer);
    };
    if (channel.readyState === "open") done();
    else channel.addEventListener("open", done, { once: true });
    channel.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        reject(new Error("channel_closed"));
      },
      { once: true },
    );
  });
}

/** One side's peer connection, as the session holds it. */
class RtcLink implements DialLink {
  readonly channel: Promise<LiveChannel>;
  readonly #pc: RTCPeerConnection;
  readonly #failed: (() => void)[] = [];
  readonly #ice = new Set<(view: IceDiagnosticView) => void>();
  #stopIce: (() => void) | null = null;
  #abandon: (error: Error) => void = () => undefined;
  #closed = false;

  constructor(
    pc: RTCPeerConnection,
    readonly handshake: string,
    ready: Promise<PeerChannel>,
  ) {
    this.#pc = pc;
    this.channel = new Promise((resolve, reject) => {
      this.#abandon = reject;
      ready.then(resolve, reject);
    });
    // A link nobody waited on may close quietly; one waited on still hears.
    this.channel.catch(() => undefined);
    this.#stopIce = watchRtcIce(pc, (view) => {
      for (const listener of this.#ice) listener(view);
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState !== "failed" || this.#closed) return;
      for (const handler of this.#failed.splice(0)) handler();
    });
  }

  onFailed(handler: () => void): void {
    if (!this.#closed) this.#failed.push(handler);
  }

  onIce(listener: (view: IceDiagnosticView) => void): () => void {
    this.#ice.add(listener);
    return () => {
      this.#ice.delete(listener);
    };
  }

  async accept(answer: string): Promise<void> {
    // Read here too: whatever reaches the browser has been read strictly.
    if (!isDataChannelSdp(answer)) throw new Error("bad_answer");
    await this.#pc.setRemoteDescription({ type: "answer", sdp: answer });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failed.length = 0;
    this.#ice.clear();
    this.#stopIce?.();
    this.#stopIce = null;
    // A channel still opening never will: whoever waits on it hears so.
    this.#abandon(new Error("link_closed"));
    this.#pc.close();
  }
}

/** The joiner's side: the offer its request code carries. */
async function dial(
  peers: PeerFactory,
  routing: PeerRouting,
): Promise<DialLink> {
  const pc = peers(rtcConfig(routing));
  const ready = opened(pc.createDataChannel(CHANNEL_LABEL, { ordered: true }));
  try {
    await pc.setLocalDescription(await pc.createOffer());
    return new RtcLink(pc, await gathered(pc, routing), ready);
  } catch (error) {
    // Nobody holds a connection that never made an offer.
    ready.catch(() => undefined);
    pc.close();
    throw error;
  }
}

/** The owner's side, for one joiner it lets in: answer the offer. */
async function answer(
  peers: PeerFactory,
  routing: PeerRouting,
  offer: string,
): Promise<PeerLink> {
  if (!isDataChannelSdp(offer)) throw new Error("bad_offer");
  const pc = peers(rtcConfig(routing));
  const ready = new Promise<PeerChannel>((resolve, reject) => {
    pc.addEventListener("datachannel", (event: RTCDataChannelEvent) => {
      if (event.channel.label !== CHANNEL_LABEL) return;
      opened(event.channel).then(resolve, reject);
    });
  });
  try {
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    return new RtcLink(pc, await gathered(pc, routing), ready);
  } catch (error) {
    // An offer the browser refuses leaves no connection behind.
    pc.close();
    throw error;
  }
}

/** WebRTC over the routes one session names. */
export function webRtcTransport(
  peers: PeerFactory,
  routing: PeerRouting,
): PeerTransport {
  return {
    readsOffer: isDataChannelSdp,
    readsAnswer: isDataChannelSdp,
    dial: () => dial(peers, routing),
    answer: (offer) => answer(peers, routing, offer),
  };
}

/** The factory a shell hands sessions: WebRTC, built on `peers`. */
export function webRtc(peers: PeerFactory): TransportFactory {
  return (routing) => webRtcTransport(peers, routing);
}
