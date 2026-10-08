/**
 * The joiner's side of a live session (ADR 0150 §3–§5).
 *
 * It makes a WebRTC offer and seals it, with the person's name and note,
 * into a request code only the owner can open, for the person to send the
 * owner — and, where the link names carriers, posts it on them too. It then
 * waits for the owner's reply code, pasted or carried: one that opens under
 * the secret this request shares with the owner key, and that answers this
 * very request — anything else is ignored and the request stays open. With
 * the reply, the two browsers connect: directly, through a tunnel the owner
 * named, or through the owner's TURN server — or, when the owner offers it
 * and no peer route opens, over the owner's NATS server, sealed end to end
 * (ADR 0167).
 *
 * Everything it receives lives in memory. When the channel closes — the
 * owner ended it, the time ran out, the owner's tab went away, or this
 * person left — the catalog and every value are dropped.
 */

import { guardedLiveCarrier } from "./host-authority.js";
import type { LiveLink } from "./link.js";
import {
  type Catalog,
  type ChannelMessage,
  VALUE_MAX,
  characters,
  cleanText,
} from "./messages.js";
import type { NatsSession } from "./nats-route.js";
import { makeRequestCode, openReplyCode } from "./pairing.js";
import {
  type IceSettings,
  type OfferSide,
  type PeerFactory,
  makeOffer,
  takeAnswer,
} from "./peer.js";
import {
  captureLiveRealmAuthority,
  watchLiveRealmAuthority,
} from "./realm-authority.js";
import type { Carrier } from "./rendezvous.js";
import { type Keypair, newKeypair, newRequestId } from "./seal.js";
import { type LiveChannel, SeatChannel, seatName } from "./seat-channel.js";

/** How often an unanswered request is posted again on the carriers. */
const REPOST_MS = 20_000;
const REPOSTS = 30;

/** How long a relayed seat gives the peer route before moving to the relay. */
export const FALLBACK_MS = 8000;

/** The carriers a joiner posts on, when the link names any. */
export type GuestCarriers = Readonly<{
  post(code: string): Promise<void>;
  close(): void;
  /** A seat's channel on a carrier that may carry the session, if any. */
  seat?: (name: string) => Carrier | null;
  /** How the link's NATS carrier carries the session; `off` without one. */
  session?: NatsSession;
}>;

export type GuestStatus =
  | Readonly<{ at: "preparing" }>
  | Readonly<{ at: "request"; code: string }>
  | Readonly<{ at: "connecting" }>
  | Readonly<{ at: "joined"; catalog: Catalog }>
  /** The browsers found no route to each other. */
  | Readonly<{ at: "unreachable" }>
  | Readonly<{ at: "ended" }>;

export type GuestOptions = Readonly<{
  link: LiveLink;
  /** The normalized code for an invite session; null for an open one. */
  code: string | null;
  name: string;
  note: string;
  ice: IceSettings;
  peers: PeerFactory;
  carriers?: GuestCarriers | null;
}>;

type Pending = { resolve: (value: string | null) => void };

export class LiveGuest {
  readonly #assertAuthority = captureLiveRealmAuthority();
  readonly #listeners = new Set<(status: GuestStatus) => void>();
  readonly #pending = new Map<string, Pending>();
  readonly #id = newRequestId();
  #status: GuestStatus = { at: "preparing" };
  #side: OfferSide | null = null;
  #offering: RTCPeerConnection | null = null;
  #relayCarrier: Carrier | null = null;
  #channel: LiveChannel | null = null;
  /** The owner offered a relay: the carriers stay open with the seat. */
  #relayed = false;
  #fallback: ReturnType<typeof setTimeout> | null = null;
  #keys: Keypair | null = null;
  #repost: ReturnType<typeof setInterval> | null = null;
  #next = 0;
  #unwatch: (() => void) | null = null;

  constructor(private readonly options: GuestOptions) {}

  assertAuthority(): void {
    this.#assertAuthority();
  }

  get status(): GuestStatus {
    this.#permitted();
    return this.#status;
  }

  subscribe(listener: (status: GuestStatus) => void): () => void {
    this.#permitted();
    this.#listeners.add(listener);
    listener(this.#status);
    return () => this.#listeners.delete(listener);
  }

  #permitted(): boolean {
    try {
      this.#assertAuthority();
      return !this.#over();
    } catch {
      this.#finish();
      return false;
    }
  }

  #to(status: GuestStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  /**
   * Make the offer and the request code that carries it; empty if the person
   * left before there was one.
   */
  async start(): Promise<string> {
    if (!this.#permitted()) return "";
    this.#unwatch ??= watchLiveRealmAuthority(() => this.#finish());
    try {
      const request = await this.#start();
      return this.#permitted() ? request : "";
    } catch (error) {
      if (!this.#permitted()) return "";
      this.#finish();
      throw error;
    }
  }

  async #start(): Promise<string> {
    const { link, code, name, note, peers, ice } = this.options;
    const keys = await newKeypair();
    if (!this.#permitted()) return "";
    this.#keys = keys;
    const side = await makeOffer((configuration) => {
      this.#assertAuthority();
      const pc = peers(configuration);
      this.#offering = pc;
      return pc;
    }, ice);
    this.#offering = null;
    if (!this.#permitted()) {
      // Left while the browser was gathering: `#finish` found no connection.
      side.pc.close();
      side.channel.catch(() => undefined);
      return "";
    }
    this.#side = side;
    side.channel.then(
      (channel) => this.#connected(channel),
      () => {
        if (!this.#relayed) this.#finish();
      },
    );
    // The owner reads these cleaned (`readJoinRequest`); say the same here.
    const request = await makeRequestCode(link, code, keys, {
      id: this.#id,
      name: cleanText(name) || "Guest",
      note: cleanText(note),
      offer: side.offer,
    });
    if (!this.#permitted()) return "";
    if (this.#status.at === "preparing") {
      this.#to({ at: "request", code: request });
      this.#carry(request);
    }
    return this.#permitted() ? request : "";
  }

  /** Post the request on the carriers, again until it is answered. */
  #carry(request: string): void {
    const { carriers } = this.options;
    if (!carriers || !this.#permitted()) return;
    void carriers.post(request);
    let left = REPOSTS;
    this.#repost = setInterval(() => {
      left -= 1;
      if (!this.#permitted() || this.#status.at !== "request") this.#release();
      // Enough reposts: stop posting, but keep listening — the owner may
      // answer long after, and a reply on a closed carrier is heard by nobody.
      else if (left <= 0) this.#stopReposts();
      else void carriers.post(request);
    }, REPOST_MS);
  }

  #stopReposts(): void {
    if (this.#repost) clearInterval(this.#repost);
    this.#repost = null;
  }

  /**
   * Done asking: a reply arrived, or the ask is over. The carriers close —
   * unless the seat may move to one of them, when they close with the seat.
   */
  #release(): void {
    this.#stopReposts();
    if (!this.#relayed) this.options.carriers?.close();
  }

  /** The owner's reply code; false (and nothing changes) if it is not one. */
  async accept(text: string): Promise<boolean> {
    if (!this.#permitted()) return false;
    const keys = this.#keys;
    if (this.#status.at !== "request" || !this.#side || !keys) return false;
    const { link, code } = this.options;
    const reply = await openReplyCode(link, code, keys, this.#id, text);
    if (!this.#permitted() || !reply || this.#status.at !== "request")
      return false;
    const session = this.options.carriers?.session ?? "off";
    this.#relayed = reply.relay === "nats" && session !== "off";
    this.#release();
    this.#to({ at: "connecting" });
    if (!this.#permitted()) return false;
    if (this.#relayed && session === "always") {
      void this.#toRelay();
      return this.#permitted();
    }
    const { pc } = this.#side;
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState !== "failed" || this.#status.at !== "connecting")
        return;
      if (this.#relayed) void this.#toRelay();
      else this.#finish({ at: "unreachable" });
    });
    if (this.#relayed)
      this.#fallback = setTimeout(() => void this.#toRelay(), FALLBACK_MS);
    return this.#answer(pc, reply.answer);
  }

  async #answer(pc: RTCPeerConnection, answer: string): Promise<boolean> {
    try {
      await takeAnswer(pc, answer);
      this.#assertAuthority();
      return this.#status.at === "unreachable" || this.#permitted();
    } catch {
      this.#finish();
      return false;
    }
  }

  /**
   * Carry the seat over the relay: the peer route, if it is still trying,
   * is dropped, and the owner hears the first sealed frame and answers it.
   */
  async #toRelay(): Promise<void> {
    if (this.#fallback) clearTimeout(this.#fallback);
    this.#fallback = null;
    const keys = this.#keys;
    if (!this.#permitted() || this.#channel || !keys) return;
    const carrier = this.options.carriers?.seat?.(seatName(this.#id)) ?? null;
    this.#relayCarrier = carrier;
    const shared = await keys.shared(this.options.link.owner);
    if (!carrier || !shared) {
      carrier?.close();
      this.#finish({ at: "unreachable" });
      return;
    }
    if (!this.#permitted() || this.#channel) {
      carrier.close();
      return;
    }
    this.#side?.pc.close();
    const channel = new SeatChannel(
      guardedLiveCarrier(carrier, () => this.#assertAuthority()),
      {
        link: this.options.link,
        code: this.options.code,
        joiner: keys.pub,
        id: this.#id,
        shared,
      },
      "joiner",
    );
    this.#connected(channel);
    if (this.#permitted()) channel.send({ t: "hello" });
  }

  #connected(channel: LiveChannel): void {
    // Over already, or the seat is carried another way: not this channel.
    if (!this.#permitted() || this.#channel) {
      channel.close();
      return;
    }
    if (this.#fallback) clearTimeout(this.#fallback);
    this.#fallback = null;
    this.#channel = channel;
    channel.onMessage((message) => this.#onMessage(message));
    channel.onClose(() => this.#finish());
  }

  #onMessage(message: ChannelMessage): void {
    if (!this.#permitted()) return;
    if (message.t === "catalog")
      this.#to({ at: "joined", catalog: message.catalog });
    else if (message.t === "end") this.#finish();
    else if (message.t === "value" || message.t === "denied") {
      const pending = this.#pending.get(message.req);
      this.#pending.delete(message.req);
      pending?.resolve(message.t === "value" ? message.value : null);
    }
  }

  /** Replace one shared field. The saved text, or null if the owner refused. */
  edit(item: string, field: string, value: string): Promise<string | null> {
    if (!this.#permitted() || this.#status.at !== "joined" || !this.#channel)
      return Promise.resolve(null);
    if (characters(value) > VALUE_MAX) return Promise.resolve(null);
    this.#next += 1;
    const req = `r${this.#next}`;
    return new Promise<string | null>((resolve) => {
      this.#pending.set(req, { resolve });
      if (this.#permitted())
        this.#channel?.send({ t: "edit", req, item, field, value });
    }).then((value) => (this.#permitted() ? value : null));
  }

  /** One concealed value, to show (`reveal`) or to copy; null if refused. */
  request(
    what: "reveal" | "copy",
    item: string,
    field: string,
  ): Promise<string | null> {
    if (!this.#permitted() || this.#status.at !== "joined" || !this.#channel)
      return Promise.resolve(null);
    this.#next += 1;
    const req = `r${this.#next}`;
    return new Promise<string | null>((resolve) => {
      this.#pending.set(req, { resolve });
      if (this.#permitted()) this.#channel?.send({ t: what, req, item, field });
    }).then((value) => (this.#permitted() ? value : null));
  }

  #over(): boolean {
    return this.#status.at === "ended" || this.#status.at === "unreachable";
  }

  #finish(end: GuestStatus = { at: "ended" }): void {
    if (this.#over()) return;
    this.#status = end;
    this.#unwatch?.();
    this.#unwatch = null;
    if (this.#fallback) clearTimeout(this.#fallback);
    this.#fallback = null;
    this.#relayed = false;
    this.#release();
    for (const pending of this.#pending.values()) pending.resolve(null);
    this.#pending.clear();
    this.#channel?.close();
    this.#side?.pc.close();
    this.#offering?.close();
    this.#offering = null;
    if (!this.#channel) this.#relayCarrier?.close();
    else {
      try {
        this.#assertAuthority();
      } catch {
        this.#relayCarrier?.close();
      }
    }
    this.#relayCarrier = null;
    this.#channel = null;
    this.#side = null;
    this.#keys = null;
    // The catalog goes with the status it rode on.
    this.#to(end);
  }

  /** Leave, dropping everything held; the owner sees the channel close. */
  leave(): void {
    this.#finish();
  }
}
