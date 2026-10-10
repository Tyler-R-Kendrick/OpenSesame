/**
 * The joiner's side of a live session (ADR 0150 §3–§5, ADR 0186).
 *
 * It dials the owner over the session's transport (`p2p.ts`) and seals the
 * offer, with the person's name and note, into a request code only the owner
 * can open, for the person to send the owner — and, where the link names
 * carriers, posts it on them too. It then waits for the owner's reply code,
 * pasted or carried: one that opens under the secret this request shares
 * with the owner key, and that answers this very request — anything else is
 * ignored and the request stays open. With the reply, the two browsers
 * connect: directly, through a tunnel the owner named, or through the
 * owner's TURN server — or, when the owner offers it and no peer route
 * opens, over the owner's NATS server, sealed end to end (ADR 0167).
 *
 * Once a channel opens it greets the owner until the catalog arrives
 * (`greeting.ts`): no one frame is trusted to arrive. The wait is bounded:
 * with no catalog `CONNECTING_TIMEOUT_MS` after the reply, the attempt is
 * over — the link closes, so the owner sees the seat go — and the person may
 * ask again with a fresh request.
 *
 * Everything it receives lives in memory. When the channel closes — the
 * owner ended it, the time ran out, the owner's tab went away, or this
 * person left — the catalog and every value are dropped.
 */

import { type ChannelRequest, ChannelRequests } from "./channel-requests.js";
import { Greeter } from "./greeting.js";
import type { LiveLink } from "./link.js";
import {
  type Catalog,
  type ChannelMessage,
  type JoinReply,
  VALUE_MAX,
  characters,
  cleanText,
} from "./messages.js";
import type { NatsSession } from "./nats-route.js";
import type { DialLink, LiveChannel, PeerTransport } from "./p2p.js";
import { makeRequestCode, openReplyCode } from "./pairing.js";
import type { Carrier } from "./rendezvous.js";
import { type Keypair, newKeypair, newRequestId } from "./seal.js";
import { SeatChannel, seatName } from "./seat-channel.js";

/** How often an unanswered request is posted again on the carriers. */
const REPOST_MS = 20_000;
const REPOSTS = 30;

/** How long a relayed seat gives the peer route before moving to the relay. */
export const FALLBACK_MS = 8000;

/** From the owner's reply to the catalog, before the attempt is given up. */
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
  /** No catalog in time: the link is closed, and the person may ask again. */
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
  /** What carries the session, over the routes the person agreed to. */
  transport: PeerTransport;
  carriers?: GuestCarriers | null;
}>;

export class LiveGuest {
  readonly #listeners = new Set<(status: GuestStatus) => void>();
  readonly #requests = new ChannelRequests();
  readonly #greeter = new Greeter();
  /** The request this attempt made; a fresh one when the person asks again. */
  #id = newRequestId();
  #status: GuestStatus = { at: "preparing" };
  #peer: DialLink | null = null;
  #channel: LiveChannel | null = null;
  /** The owner offered a relay: the carriers stay open with the seat. */
  #relayed = false;
  #fallback: ReturnType<typeof setTimeout> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #keys: Keypair | null = null;
  #repost: ReturnType<typeof setInterval> | null = null;

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

  /** Dial, and make the request code; empty if the person left first. */
  async start(): Promise<string> {
    // The owner reads these cleaned (`readJoinRequest`); say the same here.
    if (!cleanText(this.options.name)) throw new Error("join_name_required");
    this.#keys = await newKeypair();
    return this.#ask();
  }

  /** After a connect timeout: a fresh request, for the owner to let in. */
  async askAgain(): Promise<string> {
    if (this.#status.at !== "connect_timeout") return "";
    this.#id = newRequestId();
    this.#to({ at: "preparing" });
    try {
      return await this.#ask();
    } catch (error) {
      this.#finish();
      throw error;
    }
  }

  async #ask(): Promise<string> {
    const { link, code, name, note, transport } = this.options;
    const keys = this.#keys;
    if (!keys) return "";
    const peer = await transport.dial();
    if (this.#over()) {
      // Left while the transport was dialing: `#finish` found no link.
      peer.channel.catch(() => undefined);
      peer.close();
      return "";
    }
    this.#peer = peer;
    peer.channel.then(
      (channel) => {
        if (this.#peer === peer) this.#connected(channel);
        else channel.close();
      },
      () => {
        if (this.#peer === peer && !this.#relayed) this.#finish();
      },
    );
    const request = await makeRequestCode(link, code, keys, {
      id: this.#id,
      name: cleanText(name),
      note: cleanText(note),
      offer: peer.handshake,
      greets: true,
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
      // Answered, or enough reposts: stop posting, but keep listening — the
      // owner may answer long after, and a reply on a closed carrier is
      // heard by nobody.
      if (this.#status.at !== "request" || left <= 0) this.#stopReposts();
      else void carriers.post(request);
    }, REPOST_MS);
  }

  #stopReposts(): void {
    if (this.#repost) clearInterval(this.#repost);
    this.#repost = null;
  }

  /**
   * Done with the carriers: the session started without them, or is over.
   * A seat that may move to one of them keeps them, and they close with it.
   */
  #release(): void {
    this.#stopReposts();
    if (!this.#relayed) this.options.carriers?.close();
  }

  /** The owner's reply code; false (and nothing changes) if it is not one. */
  async accept(text: string): Promise<boolean> {
    const keys = this.#keys;
    const peer = this.#peer;
    if (this.#status.at !== "request" || !peer || !keys) return false;
    const { link, code, transport } = this.options;
    const reply = await openReplyCode(
      link,
      code,
      keys,
      this.#id,
      text,
      transport.readsAnswer,
    );
    if (!reply || this.#status.at !== "request" || this.#peer !== peer)
      return false;
    return this.#connectWithReply(peer, reply);
  }

  async #connectWithReply(peer: DialLink, reply: JoinReply): Promise<boolean> {
    const session = this.options.carriers?.session ?? "off";
    this.#relayed = reply.relay === "nats" && session !== "off";
    // The carriers stay open until the catalog comes: asking again uses them.
    this.#stopReposts();
    this.#to({ at: "connecting" });
    this.#armConnectTimeout();
    if (this.#relayed && session === "always") {
      void this.#toRelay();
      return true;
    }
    peer.onFailed(() => {
      if (this.#status.at !== "connecting" || this.#peer !== peer) return;
      if (this.#relayed) void this.#toRelay();
      else this.#finish({ at: "unreachable" });
    });
    if (this.#relayed)
      this.#fallback = setTimeout(() => void this.#toRelay(), FALLBACK_MS);
    try {
      await peer.accept(reply.answer);
      return true;
    } catch {
      this.#finish();
      return false;
    }
  }

  /**
   * Carry the seat over the relay: the peer route, if it is still trying,
   * is dropped, and the owner hears this side's greeting and answers it.
   */
  async #toRelay(): Promise<void> {
    this.#clearFallback();
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
    const peer = this.#peer;
    this.#peer = null;
    peer?.close();
    const seat = { link: this.options.link, code: this.options.code };
    this.#connected(
      new SeatChannel(
        carrier,
        { ...seat, joiner: keys.pub, id: this.#id, shared },
        "joiner",
      ),
    );
  }

  #armConnectTimeout(): void {
    this.#clearConnectTimeout();
    this.#connectTimer = setTimeout(() => {
      if (this.#status.at === "connecting") this.#giveUp();
    }, CONNECTING_TIMEOUT_MS);
  }

  #clearConnectTimeout(): void {
    if (this.#connectTimer) clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  #clearFallback(): void {
    if (this.#fallback) clearTimeout(this.#fallback);
    this.#fallback = null;
  }

  /** Over the transport or the relay: greet until the catalog arrives. */
  #connected(channel: LiveChannel): void {
    // Over already, or the seat is carried another way: not this channel.
    if (this.#over() || this.#channel) {
      channel.close();
      return;
    }
    this.#clearFallback();
    this.#channel = channel;
    channel.onMessage((message) => this.#onMessage(message));
    channel.onClose(() => {
      if (this.#channel === channel) this.#finish();
    });
    this.#greeter.start(() => channel.send({ t: "hello" }));
  }

  #onMessage(message: ChannelMessage): void {
    if (message.t === "catalog") this.#joined(message.catalog);
    else if (message.t === "end") this.#finish();
    else if (message.t === "value" || message.t === "denied")
      this.#requests.answer(message);
  }

  /** The first catalog is the session; a later one answered a greeting. */
  #joined(catalog: Catalog): void {
    if (this.#status.at !== "connecting") return;
    this.#greeter.stop();
    this.#clearConnectTimeout();
    this.#release();
    this.#to({ at: "joined", catalog });
  }

  /** Replace one shared field. The saved text, or null if the owner refused. */
  edit(item: string, field: string, value: string): Promise<string | null> {
    if (characters(value) > VALUE_MAX) return Promise.resolve(null);
    return this.#call({ t: "edit", item, field, value });
  }

  /** One concealed value, to show (`reveal`) or to copy; null if refused. */
  request(
    what: "reveal" | "copy",
    item: string,
    field: string,
  ): Promise<string | null> {
    return this.#call({ t: what, item, field });
  }

  /** Only in the session: before or after it, every request is refused. */
  #call(request: ChannelRequest): Promise<string | null> {
    const channel = this.#channel;
    if (this.#status.at !== "joined" || !channel) return Promise.resolve(null);
    return this.#requests.call(channel, request);
  }

  #over(): boolean {
    return this.#status.at === "ended" || this.#status.at === "unreachable";
  }

  /** Close this attempt's link and channel; the carriers are another matter. */
  #drop(): void {
    this.#greeter.stop();
    this.#clearConnectTimeout();
    this.#clearFallback();
    this.#requests.drop();
    const channel = this.#channel;
    const peer = this.#peer;
    this.#channel = null;
    this.#peer = null;
    channel?.close();
    peer?.close();
  }

  /** No catalog in time: this attempt is over, and the owner sees it go. */
  #giveUp(): void {
    this.#relayed = false;
    this.#drop();
    this.#to({ at: "connect_timeout" });
  }

  #finish(end: GuestStatus = { at: "ended" }): void {
    if (this.#over()) return;
    this.#relayed = false;
    this.#release();
    this.#drop();
    // The catalog goes with the status it rode on.
    this.#to(end);
  }

  /** Leave, dropping everything held; the owner sees the channel close. */
  leave(): void {
    this.#finish();
  }
}
