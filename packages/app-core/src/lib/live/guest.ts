/**
 * The joiner's side of a live session (ADR 0148 §3–§5).
 *
 * It asks once — with a proof that it holds the link (and the code, in an
 * invite session) — and then hears only from the owner key the link named:
 * a message from any other key is not the owner's and is dropped. It makes
 * a peer connection only on the owner's signed offer, which is the
 * admission, so asking reveals nothing about where it is.
 *
 * Everything it receives lives in memory. When the channel closes — the
 * owner ended it, the time ran out, the owner's tab went away, or this
 * person left — the catalog and every value are dropped.
 */

import type { LiveLink } from "./link.js";
import type { Catalog, ChannelMessage, RefusalReason } from "./messages.js";
import {
  type IceSettings,
  type PeerChannel,
  type PeerFactory,
  answerOffer,
} from "./peer.js";
import { joinProof } from "./proof.js";
import {
  type Incoming,
  type SignalTransport,
  Signaller,
  newSessionKey,
} from "./signal.js";

/** How long an ask waits for any answer before saying nobody is there. */
export const ASK_TIMEOUT_MS = 30_000;

export type GuestStatus =
  | Readonly<{ at: "asking" }>
  | Readonly<{ at: "waiting" }>
  | Readonly<{ at: "connecting" }>
  | Readonly<{ at: "joined"; catalog: Catalog }>
  | Readonly<{ at: "refused"; reason: RefusalReason }>
  | Readonly<{ at: "unanswered" }>
  | Readonly<{ at: "ended" }>;

export type GuestOptions = Readonly<{
  link: LiveLink;
  /** The normalized code for an invite session; null for an open one. */
  code: string | null;
  name: string;
  note: string;
  relays: readonly string[];
  ice: IceSettings;
  transport: SignalTransport;
  peers: PeerFactory;
}>;

type Pending = { resolve: (value: string | null) => void };

export class LiveGuest {
  readonly #signal: Signaller;
  readonly #listeners = new Set<(status: GuestStatus) => void>();
  readonly #pending = new Map<string, Pending>();
  #status: GuestStatus = { at: "asking" };
  #pc: RTCPeerConnection | null = null;
  #channel: PeerChannel | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #next = 0;

  constructor(private readonly options: GuestOptions) {
    this.#signal = new Signaller(
      newSessionKey(),
      options.relays,
      options.transport,
    );
  }

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

  #over(): boolean {
    const { at } = this.#status;
    return at === "refused" || at === "ended" || at === "unanswered";
  }

  /** Ask to join. */
  async ask(): Promise<void> {
    const { link, code, name, note } = this.options;
    this.#signal.listen((incoming) => void this.#hear(incoming));
    const input = {
      secret: link.secret,
      owner: link.owner,
      joiner: this.#signal.pub,
    };
    const held = await joinProof({ ...input, code: null });
    const proof = await joinProof({ ...input, code });
    this.#timer = setTimeout(() => {
      if (this.#status.at === "asking") this.#finish({ at: "unanswered" });
    }, ASK_TIMEOUT_MS);
    await this.#signal.send(link.owner, {
      t: "ask",
      name,
      note,
      held,
      proof,
    });
  }

  async #hear({ from, signal }: Incoming): Promise<void> {
    // Only the owner the link named speaks for the session.
    if (from !== this.options.link.owner || this.#over()) return;
    if (signal.t === "wait" && this.#status.at === "asking")
      this.#to({ at: "waiting" });
    else if (signal.t === "refuse")
      this.#finish({ at: "refused", reason: signal.reason });
    else if (signal.t === "offer" && !this.#pc) await this.#connect(signal.sdp);
  }

  async #connect(offer: string): Promise<void> {
    this.#to({ at: "connecting" });
    try {
      const side = await answerOffer(
        this.options.peers,
        this.options.ice,
        offer,
      );
      this.#pc = side.pc;
      await this.#signal.send(this.options.link.owner, {
        t: "answer",
        sdp: side.answer,
      });
      const channel = await side.channel;
      this.#channel = channel;
      channel.onMessage((message) => this.#onMessage(message));
      channel.onClose(() => this.#finish({ at: "ended" }));
    } catch {
      this.#finish({ at: "ended" });
    }
  }

  #onMessage(message: ChannelMessage): void {
    if (message.t === "catalog")
      this.#to({ at: "joined", catalog: message.catalog });
    else if (message.t === "end") this.#finish({ at: "ended" });
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

  #finish(status: GuestStatus): void {
    if (this.#over()) return;
    if (this.#timer) clearTimeout(this.#timer);
    for (const pending of this.#pending.values()) pending.resolve(null);
    this.#pending.clear();
    this.#channel?.close();
    this.#pc?.close();
    this.#channel = null;
    this.#pc = null;
    this.#signal.close();
    // The catalog goes with the status it rode on.
    this.#to(status);
  }

  /** Leave: tell the owner, and drop everything held. */
  leave(): void {
    if (this.#over()) return;
    void this.#signal
      .send(this.options.link.owner, { t: "bye" })
      .catch(() => {})
      .finally(() => this.#finish({ at: "ended" }));
  }
}
