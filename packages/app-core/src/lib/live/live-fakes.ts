/**
 * Test doubles for live sessions: an in-memory relay and linked fake peers.
 *
 * The relay carries real signed, NIP-44 encrypted events — the protocol under
 * test is exactly the one on the wire — and records every event so a test can
 * say what a relay saw. The peers link an offer to its answer through the
 * SDP, and a data channel through two event targets, so the protocol runs
 * end to end without WebRTC. Real WebRTC is `verify:live-join`'s job.
 */

import { overlapCast } from "@opensesame/os-domain";
import type { Event } from "nostr-tools/pure";
import type { PeerFactory } from "./peer.js";
import type { SignalFilter, SignalTransport } from "./signal.js";

type Sub = { filter: SignalFilter; onEvent: (event: Event) => void };

export class MemoryRelay {
  readonly seen: Event[] = [];
  readonly #subs = new Set<Sub>();

  transport(): SignalTransport {
    return {
      subscribe: (_relays, filter, onEvent) => {
        const sub = { filter, onEvent };
        this.#subs.add(sub);
        return () => this.#subs.delete(sub);
      },
      publish: async (_relays, event) => {
        this.seen.push(event);
        for (const sub of [...this.#subs]) {
          const to = event.tags.find((tag) => tag[0] === "p")?.[1];
          if (
            sub.filter.kinds.includes(event.kind) &&
            to &&
            sub.filter["#p"].includes(to)
          )
            queueMicrotask(() => sub.onEvent(event));
        }
      },
      close: () => {},
    };
  }
}

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  other: FakeChannel | null = null;

  constructor(readonly label: string) {
    super();
  }

  send(data: string): void {
    const other = this.other;
    if (this.readyState !== "open" || !other) return;
    // A plain event carrying `data`: all a data channel's reader looks at.
    queueMicrotask(() =>
      other.dispatchEvent(Object.assign(new Event("message"), { data })),
    );
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    this.other?.close();
  }
}

/** The fake network: offers by id, and how many peers were ever made. */
export class FakeNet {
  created = 0;
  readonly #offers = new Map<string, FakePeer>();

  factory(): PeerFactory {
    return () => {
      this.created += 1;
      // Tests exercise only the members FakePeer implements.
      const peer: RTCPeerConnection = overlapCast(new FakePeer(this));
      return peer;
    };
  }

  register(id: string, peer: FakePeer): void {
    this.#offers.set(id, peer);
  }

  find(id: string): FakePeer | undefined {
    return this.#offers.get(id);
  }
}

let counter = 0;

class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: { sdp: string } | null = null;
  channel: FakeChannel | null = null;
  #id = "";

  constructor(private readonly net: FakeNet) {
    super();
  }

  createDataChannel(label: string): FakeChannel {
    this.channel = new FakeChannel(label);
    return this.channel;
  }

  async createOffer() {
    counter += 1;
    this.#id = `fake-${counter}`;
    this.net.register(this.#id, this);
    return { type: "offer" as const, sdp: `v=0\r\na=fake:${this.#id}\r\n` };
  }

  async createAnswer() {
    return { type: "answer" as const, sdp: `v=0\r\na=fake:${this.#id}\r\n` };
  }

  async setLocalDescription(description: { sdp?: string }) {
    this.localDescription = { sdp: description.sdp ?? "" };
  }

  async setRemoteDescription(description: { type: string; sdp?: string }) {
    const id = /a=fake:(\S+)/.exec(description.sdp ?? "")?.[1] ?? "";
    if (description.type === "offer") {
      this.#id = id;
      this.net.register(`${id}:answer`, this);
      return;
    }
    // The answer arrived at the offerer: connect the two channels.
    const offerer = this.net.find(id);
    const theirs = offerer?.channel;
    if (!theirs) return;
    const mine = new FakeChannel(theirs.label);
    mine.other = theirs;
    theirs.other = mine;
    queueMicrotask(() => {
      const answerer = this.net.find(`${id}:answer`);
      answerer?.dispatchEvent(
        Object.assign(new Event("datachannel"), { channel: mine }),
      );
      mine.open();
      theirs.open();
    });
  }

  close(): void {
    this.channel?.close();
  }
}
