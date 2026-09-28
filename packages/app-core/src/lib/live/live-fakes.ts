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
  connectionState: RTCPeerConnectionState = "new";
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
    this.channel?.close();
  }
}
