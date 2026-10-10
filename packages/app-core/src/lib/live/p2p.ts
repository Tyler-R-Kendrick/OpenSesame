/**
 * The link a live session runs over, whatever carries it (ADR 0150, ADR 0186).
 *
 * A session asks three things of the link between two browsers, and nothing
 * more: an opaque **handshake** each side hands the other inside its sealed
 * pairing code (the joiner's offer, then the owner's answer), a **channel** of
 * the protocol's messages once the two meet, and word that the route between
 * them **failed**. How they meet is the transport's business. WebRTC with no
 * signalling server (`webrtc.ts`) is the one shipped. A transport that meets
 * in a room of its own, such as Trystero over Nostr or BitTorrent trackers,
 * would be another: its handshake would name the room, and nothing that
 * imports this file would change.
 *
 * What every transport keeps (ADR 0150 §4): the owner's side starts only in
 * `answer`, which the owner calls after letting the joiner in, so nobody the
 * owner has not admitted reaches the owner; and it reaches no server the owner
 * did not name in Routes (`PeerRouting`).
 *
 * A transport may lose a frame where real browsers do — WebRTC can drop the
 * first frame a side sends the instant its channel appears (ADR 0186) — so
 * the session never rests on any one frame arriving: the joiner greets until
 * it holds the catalog, and the owner answers every greeting.
 */

import type { ChannelMessage } from "./messages.js";
import type { IceServerSpec } from "./routes.js";

/** What one frame may weigh in bytes: under Chromium's 256 KiB message limit. */
export const FRAME_BYTES = 250_000;

/**
 * How long one side waits for the link after its handshake is made: long
 * enough for two people to pass each other the codes.
 */
export const PAIRING_MS = 15 * 60_000;

/** What a session needs of a channel, whichever way it is carried. */
export interface LiveChannel {
  /** Whether the frame went out: not once closed, never over `FRAME_BYTES`. */
  send(message: ChannelMessage): boolean;
  /** The one reader. Frames that arrived before it are handed over first. */
  onMessage(handler: (message: ChannelMessage) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/** How a link may reach the other browser: only what the owner named. */
export type PeerRouting = Readonly<{
  /** STUN and TURN servers. None by default: nobody else's machine. */
  servers: readonly IceServerSpec[];
  /** Through a relay server alone: neither side learns the other's address. */
  relay: boolean;
  /** Where this device is reachable through a tunnel, offered as hints. */
  addresses: readonly string[];
}>;

/** No server and no hint: the two browsers meet directly or not at all. */
export const DIRECT_ROUTING: PeerRouting = {
  servers: [],
  relay: false,
  addresses: [],
};

/** One side of a link, from its handshake until it closes. */
export interface PeerLink {
  /** What this side hands the other inside its sealed pairing code. */
  readonly handshake: string;
  /** The channel once the two sides meet; rejects if they never do. */
  readonly channel: Promise<LiveChannel>;
  /** Hear, once, that the route failed. Never after `close`. */
  onFailed(handler: () => void): void;
  /** Tear the link down, channel and all. Safe to call again. */
  close(): void;
}

/** The joiner's side: made first, finished by the owner's answer. */
export interface DialLink extends PeerLink {
  /** Take the answer the owner's reply code carried. Rejects if refused. */
  accept(answer: string): Promise<void>;
}

/** What carries live sessions between two browsers. */
export interface PeerTransport {
  /**
   * Whether a handshake is an offer (or answer) this transport could take,
   * read strictly: it comes from someone the owner has not let in yet, and
   * nothing else sees it first.
   */
  readsOffer(handshake: string): boolean;
  readsAnswer(handshake: string): boolean;
  /** The joiner's side: a link whose handshake is the offer. */
  dial(): Promise<DialLink>;
  /** The owner's side, for one joiner let in: its handshake is the answer. */
  answer(offer: string): Promise<PeerLink>;
}

/** Makes the transport for one session, over the routes its link names. */
export type TransportFactory = (routing: PeerRouting) => PeerTransport;

/** Frames held before anyone reads the channel; the catalog is one. */
const BACKLOG_MAX = 64;

/**
 * A channel's reader, and what arrived before there was one: the other side
 * may send as soon as its end opens, before this side has set a handler, and
 * a frame dropped there would be lost for good.
 */
export class Inbox {
  #handler: ((message: ChannelMessage) => void) | null = null;
  readonly #backlog: ChannelMessage[] = [];

  deliver(message: ChannelMessage): void {
    if (this.#handler) this.#handler(message);
    else if (this.#backlog.length < BACKLOG_MAX) this.#backlog.push(message);
  }

  read(handler: (message: ChannelMessage) => void): void {
    this.#handler = handler;
    for (const message of this.#backlog.splice(0)) handler(message);
  }
}
