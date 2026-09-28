/**
 * Test doubles for live sessions: linked fake peers.
 *
 * The peers link an offer to its answer through the SDP, and a data channel
 * through two event targets, so the protocol — the sealed pairing codes, the
 * catalog, the reveals — runs end to end without WebRTC. Real WebRTC is
 * `verify:live-join`'s job.
 */

import { overlapCast } from "@opensesame/os-domain";
import type { PeerFactory } from "./peer.js";
import type { CarrierFactory } from "./rendezvous.js";

/**
 * The smallest description a data-channel peer sends (`sdp.ts` reads it):
 * one section, no candidates, and the fake's id in an attribute of its own.
 */
export function fakeSdp(id = "fake-0"): string {
  return [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    `a=fake:${id}`,
    "",
  ].join("\r\n");
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
  /** No route between the two browsers: the answer lands, nothing connects. */
  unreachable = false;
  /** While set, a peer's offer (or answer) is not made until it settles. */
  holdOffer: Promise<void> | null = null;
  holdAnswer: Promise<void> | null = null;
  /** Every peer made, in order, and whether each was closed. */
  readonly peers: FakePeer[] = [];
  readonly #offers = new Map<string, FakePeer>();

  factory(): PeerFactory {
    return () => {
      this.created += 1;
      const made = new FakePeer(this);
      this.peers.push(made);
      // Tests exercise only the members FakePeer implements.
      const peer: RTCPeerConnection = overlapCast(made);
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

export class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = "complete";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: { sdp: string } | null = null;
  channel: FakeChannel | null = null;
  /** Whether `close()` was called, and whether this peer answered an offer. */
  closed = false;
  answering = false;
  #id = "";

  constructor(private readonly net: FakeNet) {
    super();
  }

  createDataChannel(label: string): FakeChannel {
    this.channel = new FakeChannel(label);
    return this.channel;
  }

  async createOffer() {
    if (this.net.holdOffer) await this.net.holdOffer;
    counter += 1;
    this.#id = `fake-${counter}`;
    this.net.register(this.#id, this);
    return { type: "offer" as const, sdp: fakeSdp(this.#id) };
  }

  async createAnswer() {
    if (this.net.holdAnswer) await this.net.holdAnswer;
    return { type: "answer" as const, sdp: fakeSdp(this.#id) };
  }

  async setLocalDescription(description: { sdp?: string }) {
    this.localDescription = { sdp: description.sdp ?? "" };
  }

  async setRemoteDescription(description: { type: string; sdp?: string }) {
    const id = /a=fake:(\S+)/.exec(description.sdp ?? "")?.[1] ?? "";
    if (description.type === "offer") {
      this.answering = true;
      this.#id = id;
      this.net.register(`${id}:answer`, this);
      return;
    }
    if (this.net.unreachable) {
      queueMicrotask(() => {
        this.connectionState = "failed";
        this.dispatchEvent(new Event("connectionstatechange"));
      });
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
      if (answerer) answerer.channel = mine;
      answerer?.dispatchEvent(
        Object.assign(new Event("datachannel"), { channel: mine }),
      );
      mine.open();
      theirs.open();
    });
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
  }
}

/**
 * A fake carrier service: topics in memory, every post heard by every
 * listener on the topic (the poster included, as real relays echo). `down`
 * refuses connections; `seen` keeps every frame for inspection.
 */
export class FakeBus {
  down = false;
  readonly seen: { topic: string; frame: string }[] = [];
  readonly #topics = new Map<string, Set<(text: string) => void>>();

  factory(): CarrierFactory {
    return async (_spec, topic) => {
      if (this.down) throw new Error("unreachable");
      const listeners = new Set<(text: string) => void>();
      return {
        post: async (frame) => {
          this.inject(topic, frame);
        },
        listen: (onText) => {
          listeners.add(onText);
          const all = this.#topic(topic);
          all.add(onText);
          return () => all.delete(onText);
        },
        close: () => {
          for (const listener of listeners) this.#topic(topic).delete(listener);
        },
      };
    };
  }

  /** Put a frame on a topic as anyone on the service could. */
  inject(topic: string, frame: string): void {
    this.seen.push({ topic, frame });
    for (const listener of [...this.#topic(topic)])
      queueMicrotask(() => listener(frame));
  }

  #topic(topic: string): Set<(text: string) => void> {
    let set = this.#topics.get(topic);
    if (!set) {
      set = new Set();
      this.#topics.set(topic, set);
    }
    return set;
  }
}
