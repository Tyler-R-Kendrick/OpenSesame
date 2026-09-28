/**
 * The owner's side of a live session (ADR 0150 §2–§5): the open tab hosts it.
 *
 * The owner pastes each request code a joiner sends. One that the link (and,
 * in an invite session, the code) does not open is a miss, and the fifth
 * miss ends the session. A request that opens waits for the owner — or, in
 * an open session, is let in at once. Letting someone in is the only thing
 * that answers their offer (`host-peer.ts`), and the answer leaves only in
 * the reply code the owner hands back, so nobody the owner turned away learns
 * where the owner is.
 *
 * The session keeps nothing in storage. It ends — for everyone, on every
 * channel — when the owner ends it, when its time runs out, or when the tab
 * that hosts it goes away.
 */

import { HostPeer, type LogEntry, type ReadField } from "./host-peer.js";
import type { LiveLink } from "./link.js";
import type { Catalog } from "./messages.js";
import { makeReplyCode, openRequestCode } from "./pairing.js";
import type { IceSettings, PeerFactory } from "./peer.js";
import { type Keypair, newCode, newKeypair, newLinkSecret } from "./seal.js";
import { type LiveRoutes, NO_ROUTES } from "./transport.js";

export const MAX_MISSES = 5;
export const MAX_GUESTS = 8;
export const MAX_SESSION_MS = 8 * 60 * 60 * 1000;

export type Admission = "invite" | "open";

export type GuestState = "asking" | "replied" | "joined" | "refused" | "gone";

export type Guest = Readonly<{
  /** The request id. */
  key: string;
  name: string;
  note: string;
  state: GuestState;
  askedAt: number;
  /** The reply code to hand back, once the owner has let them in. */
  reply: string | null;
}>;

export type HostState = Readonly<{
  status: "live" | "ended";
  endedBecause: "owner" | "expired" | "code" | null;
  guests: readonly Guest[];
  log: readonly LogEntry[];
  misses: number;
}>;

/** What pasting one request code did. */
export type Received =
  | Readonly<{ kind: "not-a-request" }>
  | Readonly<{ kind: "not-this-session"; misses: number }>
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "ended" }>
  | Readonly<{ kind: "guest"; key: string }>;

export type HostOptions = Readonly<{
  admission: Admission;
  ice: IceSettings;
  /** Epoch ms; clamped to eight hours from now. */
  expiresAt: number;
  catalog: () => Catalog;
  readField: ReadField;
  peers: PeerFactory;
  /** What the link carries for joiners: ICE servers, relay only, carriers. */
  routes?: LiveRoutes;
  /** Where a reply code goes besides the owner's screen (a carrier). */
  post?: (code: string) => void;
  now?: () => number;
}>;

type Seat = {
  guest: Guest;
  offer: string;
  /** The joiner's public key: its reply is sealed to it. */
  joiner: string;
  peer: HostPeer | null;
};

const OPEN = new Set<GuestState>(["asking", "replied", "joined"]);

/** One live session, hosted by this tab. */
export class LiveHost {
  readonly link: LiveLink;
  /** The out-of-band code, in an invite session. */
  readonly code: string | null;
  readonly expiresAt: number;
  readonly #owner: Keypair;
  readonly #seats = new Map<string, Seat>();
  readonly #listeners = new Set<(state: HostState) => void>();
  readonly #now: () => number;
  #log: LogEntry[] = [];
  #misses = 0;
  #ended: HostState["endedBecause"] = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly options: HostOptions,
    owner: Keypair,
  ) {
    this.#now = options.now ?? Date.now;
    this.#owner = owner;
    this.link = {
      admission: options.admission,
      owner: owner.pub,
      secret: newLinkSecret(),
      routes: options.routes ?? NO_ROUTES,
    };
    this.code = options.admission === "invite" ? newCode() : null;
    this.expiresAt = Math.min(options.expiresAt, this.#now() + MAX_SESSION_MS);
    this.#timer = setTimeout(
      () => this.end("expired"),
      Math.max(0, this.expiresAt - this.#now()),
    );
  }

  /** Start a session: a fresh owner key, link secret and code. */
  static async start(options: HostOptions): Promise<LiveHost> {
    return new LiveHost(options, await newKeypair());
  }

  get state(): HostState {
    return {
      status: this.#ended ? "ended" : "live",
      endedBecause: this.#ended,
      guests: [...this.#seats.values()].map((seat) => seat.guest),
      log: this.#log,
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

  #set(key: string, patch: Partial<Guest>): void {
    const seat = this.#seats.get(key);
    if (!seat) return;
    seat.guest = { ...seat.guest, ...patch };
    this.#emit();
  }

  /** A request code the owner pasted, or a carrier passed on. */
  async receive(text: string): Promise<Received> {
    if (this.#ended) return { kind: "ended" };
    const opened = await openRequestCode(
      this.link,
      this.code,
      this.#owner,
      text,
    );
    if (opened.kind === "not-a-request") return opened;
    if (opened.kind === "not-this-session") {
      this.#misses += 1;
      if (this.#misses >= MAX_MISSES) this.end("code");
      else this.#emit();
      return { kind: "not-this-session", misses: this.#misses };
    }
    const { request, joiner } = opened;
    const known = this.#seats.get(request.id);
    if (known) {
      // Asked again (a carrier dropped the reply): hand the same reply back.
      if (known.guest.reply && known.joiner === joiner)
        this.options.post?.(known.guest.reply);
      return { kind: "guest", key: request.id };
    }
    const seated = [...this.#seats.values()].filter((seat) =>
      OPEN.has(seat.guest.state),
    );
    if (seated.length >= MAX_GUESTS) return { kind: "full" };
    this.#seats.set(request.id, {
      guest: {
        key: request.id,
        name: request.name,
        note: request.note,
        state: "asking",
        askedAt: this.#now(),
        reply: null,
      },
      offer: request.offer,
      joiner,
      peer: null,
    });
    this.#emit();
    if (this.options.admission === "open") await this.admit(request.id);
    return { kind: "guest", key: request.id };
  }

  /** Let an asker in: only now is their offer answered. */
  async admit(key: string): Promise<void> {
    const seat = this.#seats.get(key);
    if (!seat || seat.guest.state !== "asking" || this.#ended) return;
    const peer = new HostPeer({
      guest: key,
      ice: this.options.ice,
      peers: this.options.peers,
      catalog: this.options.catalog,
      readField: this.options.readField,
      expiresAt: this.expiresAt,
      now: this.#now,
      onJoined: () => this.#set(key, { state: "joined", reply: null }),
      onClosed: () => this.#drop(key, "gone"),
      onLog: (entry) => {
        this.#log = [...this.#log.slice(-199), entry];
        this.#emit();
      },
    });
    seat.peer = peer;
    try {
      const answer = await peer.open(seat.offer);
      const reply = await makeReplyCode(
        this.link,
        this.code,
        this.#owner,
        seat.joiner,
        { id: key, answer },
      );
      if (seat.peer !== peer) return;
      this.#set(key, { state: "replied", reply });
      this.options.post?.(reply);
    } catch {
      this.#drop(key, "gone");
    }
  }

  /** Turn an asker away, or send a guest out. */
  refuse(key: string): void {
    this.#drop(key, "refused");
  }

  #drop(key: string, state: "gone" | "refused"): void {
    const seat = this.#seats.get(key);
    if (!seat || !OPEN.has(seat.guest.state)) return;
    seat.peer?.close();
    seat.peer = null;
    this.#set(key, { state, reply: null });
  }

  /** End the session for everyone. */
  end(because: NonNullable<HostState["endedBecause"]> = "owner"): void {
    if (this.#ended) return;
    this.#ended = because;
    if (this.#timer) clearTimeout(this.#timer);
    for (const seat of this.#seats.values()) {
      seat.peer?.close();
      seat.peer = null;
      if (OPEN.has(seat.guest.state))
        seat.guest = { ...seat.guest, state: "gone", reply: null };
    }
    this.#emit();
  }
}
