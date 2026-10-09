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

import type { LiveLink } from "./link.js";
import {
  type Catalog,
  type ChannelMessage,
  VALUE_MAX,
  characters,
  cleanText,
} from "./messages.js";
import type { NatsSession } from "./nats-route.js";
import { type JoinReply, makeRequestCode, openReplyCode } from "./pairing.js";
import {
  type IceSettings,
  type OfferSide,
  type PeerFactory,
  makeOffer,
  takeAnswer,
} from "./peer.js";
import type { Carrier } from "./rendezvous.js";
import { type Keypair, newKeypair, newRequestId } from "./seal.js";
import { type LiveChannel, SeatChannel, seatName } from "./seat-channel.js";

/** How often an unanswered request is posted again on the carriers. */
const REPOST_MS = 20_000;
const REPOSTS = 30;

/** How long a relayed seat gives the peer route before moving to the relay. */
export const FALLBACK_MS = 8000;

/** Direct connect after the owner's reply code, before the guest may retry. */
export const CONNECTING_TIMEOUT_MS = 60_000;

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
  | Readonly<{ at: "connect_timeout" }>
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
  readonly #listeners = new Set<(status: GuestStatus) => void>();
  readonly #pending = new Map<string, Pending>();
  readonly #id = newRequestId();
  #status: GuestStatus = { at: "preparing" };
  #side: OfferSide | null = null;
  #channel: LiveChannel | null = null;
  /** The owner offered a relay: the carriers stay open with the seat. */
  #relayed = false;
  #fallback: ReturnType<typeof setTimeout> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #lastReply: string | null = null;
  #keys: Keypair | null = null;
  #repost: ReturnType<typeof setInterval> | null = null;
  #next = 0;

  constructor(private readonly options: GuestOptions) {}

  get status(): GuestStatus {
    return this.#status;
  }

  subscribe(listener: (status: GuestStatus) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#status);
    return () => this.#listeners.delete(listener);
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
    const { link, code, name, note, peers, ice } = this.options;
    const keys = await newKeypair();
    this.#keys = keys;
    const side = await makeOffer(peers, ice);
    if (this.#over()) {
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
    const cleanedName = cleanText(name);
    if (!cleanedName) throw new Error("join_name_required");
    const request = await makeRequestCode(link, code, keys, {
      id: this.#id,
      name: cleanedName,
      note: cleanText(note),
      offer: side.offer,
    });
    if (this.#status.at === "preparing") {
      this.#to({ at: "request", code: request });
      this.#carry(request);
    }
    return request;
  }

  /** Post the request on the carriers, again until it is answered. */
  #carry(request: string): void {
    const { carriers } = this.options;
    if (!carriers) return;
    void carriers.post(request);
    let left = REPOSTS;
    this.#repost = setInterval(() => {
      left -= 1;
      if (this.#status.at !== "request") this.#release();
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
    const keys = this.#keys;
    if (this.#status.at !== "request" || !this.#side || !keys) return false;
    const { link, code } = this.options;
    const reply = await openReplyCode(link, code, keys, this.#id, text);
    if (!reply || this.#status.at !== "request") return false;
    return this.#connectWithReply(text, reply);
  }

  async #connectWithReply(text: string, reply: JoinReply): Promise<boolean> {
    const side = this.#side;
    if (!side) return false;
    const session = this.options.carriers?.session ?? "off";
    this.#relayed = reply.relay === "nats" && session !== "off";
    this.#release();
    this.#lastReply = text;
    this.#to({ at: "connecting" });
    this.#armConnectTimeout();
    if (this.#relayed && session === "always") {
      void this.#toRelay();
      return true;
    }
    const { pc } = side;
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState !== "failed" || this.#status.at !== "connecting")
        return;
      if (this.#relayed) void this.#toRelay();
      else this.#finish({ at: "unreachable" });
    });
    if (this.#relayed)
      this.#fallback = setTimeout(() => void this.#toRelay(), FALLBACK_MS);
    try {
      await takeAnswer(pc, reply.answer);
      return true;
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
    if (this.#over() || this.#channel || !keys) return;
    const carrier = this.options.carriers?.seat?.(seatName(this.#id)) ?? null;
    const shared = await keys.shared(this.options.link.owner);
    if (!carrier || !shared) {
      carrier?.close();
      this.#finish({ at: "unreachable" });
      return;
    }
    if (this.#over() || this.#channel) {
      carrier.close();
      return;
    }
    this.#side?.pc.close();
    const channel = new SeatChannel(
      carrier,
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
    channel.send({ t: "hello" });
  }

  #armConnectTimeout(): void {
    if (this.#connectTimer) clearTimeout(this.#connectTimer);
    this.#connectTimer = setTimeout(() => {
      if (this.#status.at !== "connecting") return;
      this.#to({ at: "connect_timeout" });
    }, CONNECTING_TIMEOUT_MS);
  }

  #clearConnectTimeout(): void {
    if (this.#connectTimer) clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  /** Try the same reply code again after a connect timeout. */
  async retryConnect(): Promise<boolean> {
    const text = this.#lastReply;
    const keys = this.#keys;
    if (this.#status.at !== "connect_timeout" || !text || !keys) return false;
    const { link, code, peers, ice } = this.options;
    const reply = await openReplyCode(link, code, keys, this.#id, text);
    if (!reply) return false;
    this.#clearConnectTimeout();
    if (this.#fallback) clearTimeout(this.#fallback);
    this.#fallback = null;
    this.#side?.pc.close();
    const side = await makeOffer(peers, ice);
    if (this.#over()) {
      side.pc.close();
      side.channel.catch(() => undefined);
      return false;
    }
    this.#side = side;
    side.channel.then(
      (channel) => this.#connected(channel),
      () => {
        if (!this.#relayed) this.#finish();
      },
    );
    return this.#connectWithReply(text, reply);
  }

  #connected(channel: LiveChannel): void {
    // Over already, or the seat is carried another way: not this channel.
    if (this.#over() || this.#channel) {
      channel.close();
      return;
    }
    this.#clearConnectTimeout();
    if (this.#fallback) clearTimeout(this.#fallback);
    this.#fallback = null;
    this.#channel = channel;
    channel.onMessage((message) => this.#onMessage(message));
    channel.onClose(() => this.#finish());
  }

  #onMessage(message: ChannelMessage): void {
    if (message.t === "catalog") {
      this.#clearConnectTimeout();
      this.#to({ at: "joined", catalog: message.catalog });
    } else if (message.t === "end") this.#finish();
    else if (message.t === "value" || message.t === "denied") {
      const pending = this.#pending.get(message.req);
      this.#pending.delete(message.req);
      pending?.resolve(message.t === "value" ? message.value : null);
    }
  }

  /** Replace one shared field. The saved text, or null if the owner refused. */
  edit(item: string, field: string, value: string): Promise<string | null> {
    if (this.#status.at !== "joined" || !this.#channel)
      return Promise.resolve(null);
    if (characters(value) > VALUE_MAX) return Promise.resolve(null);
    this.#next += 1;
    const req = `r${this.#next}`;
    return new Promise((resolve) => {
      this.#pending.set(req, { resolve });
      this.#channel?.send({ t: "edit", req, item, field, value });
    });
  }

  /** One concealed value, to show (`reveal`) or to copy; null if refused. */
  request(
    what: "reveal" | "copy",
    item: string,
    field: string,
  ): Promise<string | null> {
    if (this.#status.at !== "joined" || !this.#channel)
      return Promise.resolve(null);
    this.#next += 1;
    const req = `r${this.#next}`;
    return new Promise((resolve) => {
      this.#pending.set(req, { resolve });
      this.#channel?.send({ t: what, req, item, field });
    });
  }

  #over(): boolean {
    return this.#status.at === "ended" || this.#status.at === "unreachable";
  }

  #finish(end: GuestStatus = { at: "ended" }): void {
    if (this.#over()) return;
    this.#clearConnectTimeout();
    if (this.#fallback) clearTimeout(this.#fallback);
    this.#fallback = null;
    this.#relayed = false;
    this.#release();
    for (const pending of this.#pending.values()) pending.resolve(null);
    this.#pending.clear();
    this.#channel?.close();
    this.#side?.pc.close();
    this.#channel = null;
    this.#side = null;
    // The catalog goes with the status it rode on.
    this.#to(end);
  }

  /** Leave, dropping everything held; the owner sees the channel close. */
  leave(): void {
    this.#finish();
  }
}
