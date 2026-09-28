/**
 * The WebRTC half of a live session (ADR 0148 §3–§5).
 *
 * The joiner's page makes the offer and the owner's page answers it, each
 * description carried in a sealed pairing code a person passes on
 * (`pairing.ts`). Candidates are gathered in full before a description is
 * sealed (no trickle), so the whole handshake is those two codes.
 *
 * By default no ICE server is configured: no STUN or TURN, nobody else's
 * machine. The browsers offer their own host candidates and reach each
 * other directly — on the same network, or wherever a route between them
 * exists. The owner may add what bridges the rest (`transport.ts`): address
 * hints for a tunnel (`candidates.ts`), STUN and TURN servers, relay only.
 *
 * `RTCPeerConnection` is the shell's to construct (`PeerFactory`): app-core
 * touches no browser global, and tests hand in a fake.
 */

import { isString } from "@opensesame/os-domain";
import { withAddressHints } from "./candidates.js";
import { type ChannelMessage, readChannelMessage } from "./messages.js";

export type PeerFactory = (config: RTCConfiguration) => RTCPeerConnection;

export type IceSettings = Readonly<{
  /** Empty by default: host candidates only, no third party. */
  iceServers: readonly RTCIceServer[];
  /** Relay only: neither browser learns the other's address. */
  relay: boolean;
  /** Where this device is reachable through a tunnel; added as hints. */
  addresses: readonly string[];
}>;

/** No ICE server: the two browsers meet directly or not at all. */
export const DIRECT_ONLY: IceSettings = {
  iceServers: [],
  relay: false,
  addresses: [],
};

/**
 * How long one side waits for the channel after its code is made: long
 * enough for two people to pass each other the codes.
 */
export const PAIRING_MS = 15 * 60_000;

const CHANNEL_LABEL = "osm-live-v1";
const GATHER_MS = 8000;
/** Anything bigger than a catalog is not a message this protocol sends. */
const FRAME_MAX = 1024 * 1024;

function rtcConfig(ice: IceSettings): RTCConfiguration {
  return {
    iceServers: [...ice.iceServers],
    iceTransportPolicy: ice.relay ? "relay" : "all",
  };
}

/**
 * The local description once gathering is done, or after `GATHER_MS`, with
 * this side's address hints.
 */
async function gathered(
  pc: RTCPeerConnection,
  ice: IceSettings,
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
  return ice.relay ? sdp : withAddressHints(sdp, ice.addresses);
}

/** Frames held before anyone reads the channel; the catalog is one. */
const BACKLOG_MAX = 64;

/**
 * A data channel carrying the protocol's messages, read strictly. It
 * listens from the moment the channel exists and holds what arrives until a
 * handler is set: the other side sends as soon as its end opens, and a
 * frame dispatched before this side's open handler ran would otherwise be
 * lost — the owner would count a joiner in who never saw the catalog.
 */
export class PeerChannel {
  #handler: ((message: ChannelMessage) => void) | null = null;
  readonly #backlog: ChannelMessage[] = [];

  constructor(private readonly channel: RTCDataChannel) {
    channel.addEventListener("message", (event: MessageEvent) => {
      const { data } = event;
      if (!isString(data) || data.length > FRAME_MAX) return;
      const message = readChannelMessage(data);
      if (!message) return;
      if (this.#handler) this.#handler(message);
      else if (this.#backlog.length < BACKLOG_MAX) this.#backlog.push(message);
    });
  }

  send(message: ChannelMessage): void {
    if (this.channel.readyState !== "open") return;
    const frame = JSON.stringify(message);
    if (frame.length <= FRAME_MAX) this.channel.send(frame);
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.#handler = handler;
    for (const message of this.#backlog.splice(0)) handler(message);
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

export type OfferSide = Readonly<{
  pc: RTCPeerConnection;
  offer: string;
  channel: Promise<PeerChannel>;
}>;

/** The joiner's side: the offer its request code carries. */
export async function makeOffer(
  factory: PeerFactory,
  ice: IceSettings,
): Promise<OfferSide> {
  const pc = factory(rtcConfig(ice));
  const channel = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  return { pc, offer: await gathered(pc, ice), channel: opened(channel) };
}

/** Finish the joiner's side with the answer the owner's reply carries. */
export async function takeAnswer(
  pc: RTCPeerConnection,
  answer: string,
): Promise<void> {
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
}

export type AnswerSide = Readonly<{
  pc: RTCPeerConnection;
  answer: string;
  channel: Promise<PeerChannel>;
}>;

/** The owner's side, for one joiner it lets in: answer the offer. */
export async function answerOffer(
  factory: PeerFactory,
  ice: IceSettings,
  offer: string,
): Promise<AnswerSide> {
  const pc = factory(rtcConfig(ice));
  const channel = new Promise<PeerChannel>((resolve, reject) => {
    pc.addEventListener("datachannel", (event: RTCDataChannelEvent) => {
      if (event.channel.label !== CHANNEL_LABEL) return;
      opened(event.channel).then(resolve, reject);
    });
  });
  await pc.setRemoteDescription({ type: "offer", sdp: offer });
  await pc.setLocalDescription(await pc.createAnswer());
  return { pc, answer: await gathered(pc, ice), channel };
}
