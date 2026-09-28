/**
 * The WebRTC half of a live session (ADR 0148 §3–§5).
 *
 * The joiner's page makes the offer and the owner's page answers it, each
 * description carried in a sealed pairing code a person passes on
 * (`pairing.ts`). Candidates are gathered in full before a description is
 * sealed (no trickle), so the whole handshake is those two codes.
 *
 * No ICE server is configured: no STUN or TURN, nobody else's machine. The
 * browsers offer only their own host candidates and reach each other
 * directly — on the same network, or wherever a route between them exists —
 * or not at all.
 *
 * `RTCPeerConnection` is the shell's to construct (`PeerFactory`): app-core
 * touches no browser global, and tests hand in a fake.
 */

import { isString } from "@opensesame/os-domain";
import { type ChannelMessage, readChannelMessage } from "./messages.js";

export type PeerFactory = (config: RTCConfiguration) => RTCPeerConnection;

export type IceSettings = Readonly<{
  /** Empty by default: host candidates only, no third party. */
  iceServers: readonly RTCIceServer[];
}>;

/** No ICE server: the two browsers meet directly or not at all. */
export const DIRECT_ONLY: IceSettings = { iceServers: [] };

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
  };
}

/** The local description once gathering is done, or after `GATHER_MS`. */
async function gathered(pc: RTCPeerConnection): Promise<string> {
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
  return sdp;
}

/** A data channel carrying the protocol's messages, read strictly. */
export class PeerChannel {
  constructor(private readonly channel: RTCDataChannel) {}

  send(message: ChannelMessage): void {
    if (this.channel.readyState !== "open") return;
    const frame = JSON.stringify(message);
    if (frame.length <= FRAME_MAX) this.channel.send(frame);
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.channel.addEventListener("message", (event: MessageEvent) => {
      const { data } = event;
      if (!isString(data) || data.length > FRAME_MAX) return;
      const message = readChannelMessage(data);
      if (message) handler(message);
    });
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("channel_timeout")),
      PAIRING_MS,
    );
    const done = () => {
      clearTimeout(timer);
      resolve(new PeerChannel(channel));
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
  return { pc, offer: await gathered(pc), channel: opened(channel) };
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
  return { pc, answer: await gathered(pc), channel };
}
