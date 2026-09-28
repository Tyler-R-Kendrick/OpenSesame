/**
 * The owner's side of a live session (ADR 0148 §2–§5): the open tab hosts it.
 *
 * It listens on the relays for asks addressed to the session key, drops any
 * that cannot prove the link, counts a wrong code from one that can and ends
 * the session on the fifth miss, and holds every good ask for the owner — or, in
 * an open session, admits it at once. Admitting is the only thing that
 * creates a peer connection (`host-peer.ts`); a pending or refused asker
 * never learns an address.
 *
 * The session keeps nothing in storage. It ends — for everyone, on every
 * channel — when the owner ends it, when its time runs out, or when the tab
 * that hosts it goes away.
 */

import { HostPeer, type LogEntry, type ReadField } from "./host-peer.js";
import type { LiveLink } from "./link.js";
import { type Catalog, NAME_MAX, NOTE_MAX, characters } from "./messages.js";
import type { IceSettings, PeerFactory } from "./peer.js";
import { checkJoinProof, newCode, newLinkSecret } from "./proof.js";
import {
  type Incoming,
  type SessionKey,
  type SignalTransport,
  Signaller,
  newSessionKey,
} from "./signal.js";

export const MAX_MISSES = 5;
export const MAX_GUESTS = 8;
export const MAX_SESSION_MS = 8 * 60 * 60 * 1000;

export type Admission = "invite" | "open";

export type GuestState =
  | "asking"
  | "connecting"
  | "joined"
  | "refused"
  | "gone";

export type Guest = Readonly<{
  key: string;
  name: string;
  note: string;
  state: GuestState;
  askedAt: number;
}>;

export type HostState = Readonly<{
  status: "live" | "ended";
  endedBecause: "owner" | "expired" | "code" | "closed" | null;
  guests: readonly Guest[];
  log: readonly LogEntry[];
  misses: number;
}>;

export type HostOptions = Readonly<{
  admission: Admission;
  relays: readonly string[];
  ice: IceSettings;
  /** Epoch ms; clamped to eight hours from now. */
  expiresAt: number;
  catalog: () => Catalog;
  readField: ReadField;
  transport: SignalTransport;
  peers: PeerFactory;
  now?: () => number;
}>;

type Seat = { guest: Guest; peer: HostPeer | null };

/** One live session, hosted by this tab. */
export class LiveHost {
  readonly link: LiveLink;
  /** The out-of-band code, in an invite session. */
  readonly code: string | null;
  readonly expiresAt: number;
  readonly #key: SessionKey;
  readonly #signal: Signaller;
  readonly #seats = new Map<string, Seat>();
  readonly #listeners = new Set<(state: HostState) => void>();
  readonly #now: () => number;
  #log: LogEntry[] = [];
  #misses = 0;
  #ended: HostState["endedBecause"] = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: HostOptions) {
    this.#now = options.now ?? Date.now;
    this.#key = newSessionKey();
    this.link = {
      admission: options.admission,
      owner: this.#key.pub,
      secret: newLinkSecret(),
      relays: options.relays,
    };
    this.code = options.admission === "invite" ? newCode() : null;
    this.expiresAt = Math.min(options.expiresAt, this.#now() + MAX_SESSION_MS);
    this.#signal = new Signaller(
      this.#key,
      options.relays,
      options.transport,
      this.#now,
    );
  }

  start(): void {
    this.#signal.listen((incoming) => void this.#hear(incoming));
    this.#timer = setTimeout(
      () => this.end("expired"),
      Math.max(0, this.expiresAt - this.#now()),
    );
    this.#emit();
  }

  get state(): HostState {
    return {
      status: this.#ended ? "ended" : "live",
      endedBecause: this.#ended,
      guests: [...this.#seats.values()].map((seat) => seat.guest),
      log: [...this.#log],
      misses: this.#misses,
    };
  }

  subscribe(listener: (state: HostState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }

  #set(key: string, state: GuestState): void {
    const seat = this.#seats.get(key);
    if (!seat) return;
    seat.guest = { ...seat.guest, state };
    this.#emit();
  }

  async #hear({ from, signal }: Incoming): Promise<void> {
    if (this.#ended) return;
    if (signal.t === "ask") await this.#ask(from, signal);
    else if (signal.t === "answer")
      await this.#seats.get(from)?.peer?.answer(signal.sdp);
    else if (signal.t === "bye") this.#drop(from, "gone");
  }

  async #ask(
    from: string,
    ask: Readonly<{ name: string; note: string; held: string; proof: string }>,
  ): Promise<void> {
    if (this.#seats.has(from)) return;
    const input = {
      secret: this.link.secret,
      owner: this.link.owner,
      joiner: from,
    };
    // The session key is public once the owner has answered anyone, so an
    // ask that cannot prove the link is noise: dropped, never counted, or a
    // relay onlooker could end the session with five of them.
    if (!(await checkJoinProof({ ...input, code: null }, ask.held))) return;
    const good = await checkJoinProof({ ...input, code: this.code }, ask.proof);
    if (!good) {
      this.#misses += 1;
      await this.#signal
        .send(from, { t: "refuse", reason: "code" })
        .catch(() => {});
      if (this.#misses >= MAX_MISSES) this.end("code");
      else this.#emit();
      return;
    }
    const live = [...this.#seats.values()].filter(
      (seat) => seat.guest.state !== "gone" && seat.guest.state !== "refused",
    );
    if (live.length >= MAX_GUESTS) {
      await this.#signal
        .send(from, { t: "refuse", reason: "full" })
        .catch(() => {});
      return;
    }
    const name = characters(ask.name) <= NAME_MAX ? ask.name : "";
    const note = characters(ask.note) <= NOTE_MAX ? ask.note : "";
    this.#seats.set(from, {
      guest: { key: from, name, note, state: "asking", askedAt: this.#now() },
      peer: null,
    });
    this.#emit();
    if (this.options.admission === "open") await this.admit(from);
    else await this.#signal.send(from, { t: "wait" }).catch(() => {});
  }

  /** Let a waiting asker in: only now is a peer connection made. */
  async admit(key: string): Promise<void> {
    const seat = this.#seats.get(key);
    if (!seat || seat.guest.state !== "asking" || this.#ended) return;
    this.#set(key, "connecting");
    seat.peer = new HostPeer({
      guest: key,
      ice: this.options.ice,
      peers: this.options.peers,
      catalog: this.options.catalog,
      readField: this.options.readField,
      expiresAt: this.expiresAt,
      now: this.#now,
      send: (signal) => this.#signal.send(key, signal),
      onJoined: () => this.#set(key, "joined"),
      onClosed: () => this.#drop(key, "gone"),
      onLog: (entry) => {
        this.#log = [...this.#log.slice(-199), entry];
        this.#emit();
      },
    });
    await seat.peer.open().catch(() => this.#drop(key, "gone"));
  }

  /** Turn an asker away, or send a joined guest out. */
  async refuse(key: string): Promise<void> {
    const seat = this.#seats.get(key);
    if (!seat) return;
    await this.#signal
      .send(key, { t: "refuse", reason: "declined" })
      .catch(() => {});
    this.#drop(key, "refused");
  }

  #drop(key: string, state: "gone" | "refused"): void {
    const seat = this.#seats.get(key);
    if (!seat || seat.guest.state === state) return;
    seat.peer?.close();
    seat.peer = null;
    this.#set(key, state);
  }

  /** End the session for everyone. */
  end(because: NonNullable<HostState["endedBecause"]> = "owner"): void {
    if (this.#ended) return;
    this.#ended = because;
    if (this.#timer) clearTimeout(this.#timer);
    for (const [key, seat] of this.#seats) {
      seat.peer?.close();
      if (seat.guest.state !== "gone" && seat.guest.state !== "refused")
        void this.#signal
          .send(key, { t: "refuse", reason: "ended" })
          .catch(() => {});
    }
    // Let the last notices leave before the sockets close.
    setTimeout(() => this.#signal.close(), 1000);
    this.#emit();
  }
}
