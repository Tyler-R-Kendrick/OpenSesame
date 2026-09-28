/**
 * The joiner's side of a live session (ADR 0148 §3–§5).
 *
 * It makes a WebRTC offer and seals it, with the person's name and note,
 * into a request code for them to send the owner. It then waits for the
 * owner's reply code: one the owner key signed, that opens with this link
 * (and code), and that answers this very request — anything else is refused
 * and the request stays open. With the reply, the two browsers connect
 * directly.
 *
 * Everything it receives lives in memory. When the channel closes — the
 * owner ended it, the time ran out, the owner's tab went away, or this
 * person left — the catalog and every value are dropped.
 */

import type { LiveLink } from "./link.js";
import type { Catalog, ChannelMessage } from "./messages.js";
import { makeRequestCode, openReplyCode } from "./pairing.js";
import {
  type IceSettings,
  type OfferSide,
  type PeerChannel,
  type PeerFactory,
  makeOffer,
  takeAnswer,
} from "./peer.js";
import { newRequestId } from "./seal.js";

export type GuestStatus =
  | Readonly<{ at: "preparing" }>
  | Readonly<{ at: "request"; code: string }>
  | Readonly<{ at: "connecting" }>
  | Readonly<{ at: "joined"; catalog: Catalog }>
  /** The browsers found no direct route to each other. */
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
}>;

type Pending = { resolve: (value: string | null) => void };

export class LiveGuest {
  readonly #listeners = new Set<(status: GuestStatus) => void>();
  readonly #pending = new Map<string, Pending>();
  readonly #id = newRequestId();
  #status: GuestStatus = { at: "preparing" };
  #side: OfferSide | null = null;
  #channel: PeerChannel | null = null;
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

  /** Make the offer and the request code that carries it. */
  async start(): Promise<string> {
    const { link, code, name, note, peers, ice } = this.options;
    const side = await makeOffer(peers, ice);
    this.#side = side;
    side.channel.then(
      (channel) => this.#connected(channel),
      () => this.#finish(),
    );
    const request = await makeRequestCode(link, code, {
      id: this.#id,
      name,
      note,
      offer: side.offer,
    });
    if (this.#status.at === "preparing")
      this.#to({ at: "request", code: request });
    return request;
  }

  /** The owner's reply code; false (and nothing changes) if it is not one. */
  async accept(text: string): Promise<boolean> {
    if (this.#status.at !== "request" || !this.#side) return false;
    const { link, code } = this.options;
    const reply = await openReplyCode(link, code, this.#id, text);
    if (!reply || this.#status.at !== "request") return false;
    this.#to({ at: "connecting" });
    const { pc } = this.#side;
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" && this.#status.at === "connecting")
        this.#finish({ at: "unreachable" });
    });
    try {
      await takeAnswer(pc, reply.answer);
      return true;
    } catch {
      this.#finish();
      return false;
    }
  }

  #connected(channel: PeerChannel): void {
    if (this.#over()) {
      channel.close();
      return;
    }
    this.#channel = channel;
    channel.onMessage((message) => this.#onMessage(message));
    channel.onClose(() => this.#finish());
  }

  #onMessage(message: ChannelMessage): void {
    if (message.t === "catalog")
      this.#to({ at: "joined", catalog: message.catalog });
    else if (message.t === "end") this.#finish();
    else if (message.t === "value" || message.t === "denied") {
      const pending = this.#pending.get(message.req);
      this.#pending.delete(message.req);
      pending?.resolve(message.t === "value" ? message.value : null);
    }
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
