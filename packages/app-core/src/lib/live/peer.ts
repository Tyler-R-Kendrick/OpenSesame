/**
 * The WebRTC half of a live session (ADR 0148 §4–§5).
 *
 * Nothing here runs before the owner admits someone: the owner creates the
 * peer connection — and so gathers candidates — only for an admitted joiner,
 * and the joiner only on receiving that owner-signed offer. Candidates are
 * gathered in full before the description is sent (no trickle), so the
 * whole handshake is two signalling messages, and every address in it rides
 * inside the encrypted, signed signal.
 *
 * `RTCPeerConnection` is the shell's to construct (`PeerFactory`): app-core
 * touches no browser global, and tests hand in a fake.
 */

import { isString } from "@opensesame/os-domain";
import { type ChannelMessage, readChannelMessage } from "./messages.js";

export type PeerFactory = (config: RTCConfiguration) => RTCPeerConnection;

export type IceSettings = Readonly<{
  iceServers: readonly RTCIceServer[];
  /** TURN only: no direct address is ever offered, even after admission. */
  relayOnly: boolean;
}>;

const CHANNEL_LABEL = "osm-live-v1";
const GATHER_MS = 8000;
/** Anything bigger than a catalog is not a message this protocol sends. */
const FRAME_MAX = 1024 * 1024;

function rtcConfig(ice: IceSettings): RTCConfiguration {
  return {
    iceServers: [...ice.iceServers],
    iceTransportPolicy: ice.relayOnly ? "relay" : "all",
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
      30_000,
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

/** The owner's side, for one admitted joiner. */
export async function makeOffer(
  factory: PeerFactory,
  ice: IceSettings,
): Promise<OfferSide> {
  const pc = factory(rtcConfig(ice));
  const channel = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  return { pc, offer: await gathered(pc), channel: opened(channel) };
}

/** Finish the owner's side with the joiner's answer. */
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

/** The joiner's side: answer the owner's offer. */
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
