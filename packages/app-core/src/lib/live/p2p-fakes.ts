/**
 * A transport with no WebRTC in it (ADR 0186): links meet in memory by their
 * handshakes, so a live session runs end to end over something that is not
 * a browser's peer connection — which is the point of `p2p.ts`.
 *
 * It can lose frames on demand, the way WebRTC loses the first frame a side
 * sends as its channel appears, and it can have no route at all. Frames cross
 * as text and are read as strictly as any transport's.
 */

import { type ChannelMessage, readChannelMessage } from "./messages.js";
import {
  type DialLink,
  Inbox,
  type LiveChannel,
  type PeerTransport,
  type TransportFactory,
} from "./p2p.js";

const OFFER = /^mem:\d+$/;
const ANSWER = /^mem:\d+:answer$/;

class MemoryChannel implements LiveChannel {
  other: MemoryChannel | null = null;
  readonly #inbox = new Inbox();
  readonly #closers: (() => void)[] = [];
  #closed = false;

  constructor(
    private readonly net: MemoryNet,
    readonly side: "owner" | "joiner",
  ) {}

  send(message: ChannelMessage): boolean {
    const other = this.other;
    if (this.#closed || !other) return false;
    this.net.sent.push({ side: this.side, message });
    if (this.net.lose(this.side)) return true;
    const frame = JSON.stringify(message);
    queueMicrotask(() => other.receive(frame));
    return true;
  }

  receive(frame: string): void {
    const message = readChannelMessage(frame);
    if (message && !this.#closed) this.#inbox.deliver(message);
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.#inbox.read(handler);
  }

  onClose(handler: () => void): void {
    this.#closers.push(handler);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const closer of this.#closers.splice(0)) closer();
    this.other?.close();
  }
}

class MemoryLink implements DialLink {
  readonly channel: Promise<LiveChannel>;
  readonly mine: MemoryChannel;
  closed = false;
  #open: (channel: LiveChannel) => void = () => undefined;
  #abandon: (error: Error) => void = () => undefined;
  readonly #failed: (() => void)[] = [];

  constructor(
    private readonly net: MemoryNet,
    readonly handshake: string,
    side: "owner" | "joiner",
  ) {
    this.mine = new MemoryChannel(net, side);
    this.channel = new Promise((resolve, reject) => {
      this.#open = resolve;
      this.#abandon = reject;
    });
    this.channel.catch(() => undefined);
  }

  onFailed(handler: () => void): void {
    if (!this.closed) this.#failed.push(handler);
  }

  fail(): void {
    if (this.closed) return;
    for (const handler of this.#failed.splice(0)) handler();
  }

  open(): void {
    if (!this.closed) this.#open(this.mine);
  }

  async accept(answer: string): Promise<void> {
    if (!ANSWER.test(answer)) throw new Error("bad_answer");
    this.net.meet(this, answer);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#failed.length = 0;
    this.#abandon(new Error("link_closed"));
    this.mine.close();
  }
}

/** The network the memory transport's links meet on. */
export class MemoryNet {
  /** Frames each side loses before one gets through. */
  readonly losing = { owner: 0, joiner: 0 };
  /** Every frame sent, lost or not, by side. */
  readonly sent: { side: "owner" | "joiner"; message: ChannelMessage }[] = [];
  /** No route between the two: the answer lands, nothing connects. */
  unreachable = false;
  readonly links: MemoryLink[] = [];
  readonly #dialed = new Map<string, MemoryLink>();
  readonly #answered = new Map<string, MemoryLink>();
  #count = 0;

  /** Whether the next frame from `side` is lost; counts it down if so. */
  lose(side: "owner" | "joiner"): boolean {
    if (this.losing[side] <= 0) return false;
    this.losing[side] -= 1;
    return true;
  }

  /** The joiner's link took the owner's answer: connect, or fail. */
  meet(joiner: MemoryLink, answer: string): void {
    const owner = this.#answered.get(answer);
    queueMicrotask(() => {
      if (this.unreachable || !owner || owner.closed) {
        joiner.fail();
        owner?.fail();
        return;
      }
      owner.mine.other = joiner.mine;
      joiner.mine.other = owner.mine;
      owner.open();
      joiner.open();
    });
  }

  transport(): PeerTransport {
    return {
      readsOffer: (handshake) => OFFER.test(handshake),
      readsAnswer: (handshake) => ANSWER.test(handshake),
      dial: async () => {
        this.#count += 1;
        const link = new MemoryLink(this, `mem:${this.#count}`, "joiner");
        this.#dialed.set(link.handshake, link);
        this.links.push(link);
        return link;
      },
      answer: async (offer) => {
        if (!this.#dialed.has(offer)) throw new Error("bad_offer");
        const link = new MemoryLink(this, `${offer}:answer`, "owner");
        this.#answered.set(link.handshake, link);
        this.links.push(link);
        return link;
      },
    };
  }

  transports(): TransportFactory {
    return () => this.transport();
  }
}
