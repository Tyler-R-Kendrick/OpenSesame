/**
 * One admitted seat's session carried over a NATS carrier instead of a
 * WebRTC data channel (ADR 0167), for when the two browsers find no route
 * to each other — or always, if the owner said so.
 *
 * The carrier is a subject only the session's credential holders can reach,
 * and every frame on it is sealed end to end with the keys the pairing
 * already established (`seal.ts`, purpose `channel`): the ECDH secret the
 * owner and this joiner share, the link secret and, in an invite session,
 * the out-of-band code. Each frame is bound to the seat (owner key, joiner
 * key, request id), its direction and its sequence number, so a frame from
 * another seat, the other direction or an earlier moment does not open, and
 * a frame that did open is never accepted twice. What the server, or any
 * other link holder, sees is ciphertext and its length.
 *
 * It is a `LiveChannel` like any transport's (`p2p.ts`) and keeps its
 * contract: send reports whether the frame went out, nothing over
 * `FRAME_BYTES` is sent, and what arrives before a handler is held for it.
 */

import type { LiveLink } from "./link.js";
import { type ChannelMessage, readChannelMessage } from "./messages.js";
import { FRAME_BYTES, Inbox, type LiveChannel } from "./p2p.js";
import type { Carrier } from "./rendezvous.js";
import { type SealContext, seal, unseal } from "./seal.js";

/** What seals one seat's frames: the pairing's own key material. */
export type SeatKeys = Readonly<{
  link: LiveLink;
  /** The normalized code in an invite session; null in an open one. */
  code: string | null;
  /** The joiner's public key. */
  joiner: string;
  /** The request the seat was made for. */
  id: string;
  shared: Uint8Array<ArrayBuffer>;
}>;

/** Which end of the seat this tab is. */
export type SeatSide = "owner" | "joiner";

const PREFIX = "osc1";
const FRAME_MAX = 2 * 1024 * 1024;
const SEQ = /^[1-9]\d{0,14}$/;

/** The subject suffix a seat's frames travel on. */
export function seatName(id: string): string {
  return `seat.${id}`;
}

export class SeatChannel implements LiveChannel {
  readonly #carrier: Carrier;
  readonly #keys: SeatKeys;
  readonly #out: "h" | "g";
  readonly #in: "h" | "g";
  readonly #stop: () => void;
  readonly #closers: (() => void)[] = [];
  readonly #inbox = new Inbox();
  #sent = 0;
  #seen = 0;
  #closed = false;
  #sending: Promise<void> = Promise.resolve();
  #reading: Promise<void> = Promise.resolve();

  constructor(carrier: Carrier, keys: SeatKeys, side: SeatSide) {
    this.#carrier = carrier;
    this.#keys = keys;
    this.#out = side === "owner" ? "h" : "g";
    this.#in = side === "owner" ? "g" : "h";
    this.#stop = carrier.listen((text) => {
      // In order: each frame is opened only after the one before it.
      this.#reading = this.#reading.then(() => this.#receive(text));
    });
  }

  #context(direction: "h" | "g", seq: number): SealContext {
    const { link, code, joiner, id, shared } = this.#keys;
    return {
      secret: link.secret,
      code,
      purpose: "channel",
      bound: [link.owner, joiner, id, direction, String(seq)],
      shared,
    };
  }

  send(message: ChannelMessage): boolean {
    if (this.#closed) return false;
    const plain = JSON.stringify(message);
    if (new TextEncoder().encode(plain).length > FRAME_BYTES) return false;
    this.#sent += 1;
    const seq = this.#sent;
    this.#sending = this.#sending
      .then(async () => {
        const sealed = await seal(this.#context(this.#out, seq), plain);
        await this.#carrier.post(`${PREFIX}.${this.#out}.${seq}.${sealed}`);
      })
      // A frame that cannot go out ends the seat, as a failed send does.
      .catch(() => this.#end());
    return true;
  }

  /** The sequence and sealed body of a frame from the other end, or null. */
  #parse(text: string): Readonly<{ seq: number; sealed: string }> | null {
    if (this.#closed || text.length > FRAME_MAX) return null;
    const [prefix, direction, seq, sealed, ...rest] = text.split(".");
    if (prefix !== PREFIX || direction !== this.#in || rest.length > 0)
      return null;
    if (!seq || !SEQ.test(seq) || !sealed) return null;
    return { seq: Number(seq), sealed };
  }

  async #receive(text: string): Promise<void> {
    const frame = this.#parse(text);
    // Only forward: a replay or a stale frame is dropped, and a frame the
    // carrier lost costs that frame, never the session.
    if (!frame || frame.seq <= this.#seen) return;
    const plain = await unseal(
      this.#context(this.#in, frame.seq),
      frame.sealed,
    );
    if (plain === null || this.#closed || frame.seq <= this.#seen) return;
    this.#seen = frame.seq;
    const message = readChannelMessage(plain);
    if (message) this.#deliver(message);
  }

  #deliver(message: ChannelMessage): void {
    if (message.t === "end") this.#end();
    else this.#inbox.deliver(message);
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.#inbox.read(handler);
  }

  onClose(handler: () => void): void {
    this.#closers.push(handler);
  }

  /** Tell the other end, then stop. */
  close(): void {
    if (this.#closed) return;
    this.send({ t: "end" });
    this.#end();
  }

  /** However it ends, the seat's subject is let go once what was sent is out. */
  #end(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop();
    void this.#sending.finally(() => this.#carrier.close());
    for (const closer of this.#closers.splice(0)) closer();
  }
}
