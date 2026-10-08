/**
 * The owner's side of a live session (ADR 0150 §2–§5): the open tab hosts it.
 *
 * The owner pastes each request code a joiner sends, or a carrier passes it
 * on. In an invite session, a code the link did not open is a miss, and the
 * fifth miss **locks** the session: no new request is taken, and everyone
 * already asking or in stays. An open session has no code to guess, so a
 * request that does not open there is not a miss. A reposted code is the same
 * miss, not a new one. Ending the session is not how it locks: anyone holding
 * the link could then throw out the people already in. Letting someone in is
 * the only answer to their offer (`host-peer.ts`), and that answer leaves only
 * in the reply code, so nobody turned away learns where the owner is.
 *
 * A seat is not kept for ever: one that is asking or let in but never connects
 * expires after the pairing window, and an ended seat is forgotten shortly
 * after, so requests that never finish cannot fill the session or grow it.
 *
 * The session keeps nothing in storage. It ends — for everyone, on every
 * channel — when the owner ends it, when its time runs out, or when the tab
 * that hosts it goes away.
 */

import { noteLiveSessionGranted } from "../sharing-receipts.js";
import {
  HostPeer,
  type LogEntry,
  type ReadField,
  type WriteField,
} from "./host-peer.js";
import type { LiveLink } from "./link.js";
import type { Catalog } from "./messages.js";
import { makeReplyCode, openRequestCode } from "./pairing.js";
import { type IceSettings, PAIRING_MS, type PeerFactory } from "./peer.js";
import type { Carrier } from "./rendezvous.js";
import { type LiveRoutes, NO_ROUTES, routesSegment } from "./routes.js";
import { type Keypair, newCode, newKeypair, newLinkSecret } from "./seal.js";
import { seatName } from "./seat-channel.js";

export const MAX_MISSES = 5;
export const MAX_GUESTS = 8;
/** How long a seat that has ended stays listed before it is forgotten. */
export const SEAT_GRACE_MS = 60_000;
/** How many distinct wrong codes are remembered; each still counts as a miss. */
const MISSED_MAX = 256;
/** How many forgotten requests are remembered, so a repost is not seated again. */
const CLOSED_MAX = 256;
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
  endedBecause: "owner" | "expired" | null;
  guests: readonly Guest[];
  log: readonly LogEntry[];
  misses: number;
  /** Too many wrong codes: no new request is taken; the people in stay. */
  locked: boolean;
}>;

/** What pasting one request code did. */
export type Received =
  /** Not a request for this session, or one that has already closed. */
  | Readonly<{ kind: "not-a-request" }>
  | Readonly<{ kind: "not-this-session"; misses: number }>
  /** The session is locked: it takes no new request. */
  | Readonly<{ kind: "locked" }>
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
  /** Present when the session may write a shared field back. Absent denies. */
  writeField?: WriteField;
  peers: PeerFactory;
  /** What the link carries for joiners: ICE servers, relay only, carriers. */
  routes?: LiveRoutes;
  /** Where a reply code goes besides the owner's screen (a carrier). */
  post?: (code: string) => void;
  /**
   * A seat's channel on a carrier that may carry the session (NATS), or
   * null when none can; asked at each admission (ADR 0167).
   */
  relay?: (name: string) => Carrier | null;
  /** The link secret, when the caller minted credentials for its topic. */
  secret?: string;
  now?: () => number;
}>;

type Seat = {
  guest: Guest;
  offer: string;
  /** The joiner's public key: its reply is sealed to it. */
  joiner: string;
  peer: HostPeer | null;
  /** An admit is waiting on its peer's answer: a second must not start. */
  admitting: boolean;
  /** The seat's expiry while it waits, or its removal once it has ended. */
  timer: ReturnType<typeof setTimeout> | null;
};

const OPEN = new Set<GuestState>(["asking", "replied", "joined"]);
const seatState = (seat: Seat | undefined) => seat?.guest.state;

/** One live session, hosted by this tab. */
export class LiveHost {
  readonly link: LiveLink;
  /** Receipt id. Not the link secret and not the invite code. */
  readonly id = crypto.randomUUID();
  /** The out-of-band code, in an invite session. */
  readonly code: string | null;
  readonly expiresAt: number;
  readonly #owner: Keypair;
  readonly #seats = new Map<string, Seat>();
  readonly #listeners = new Set<(state: HostState) => void>();
  readonly #now: () => number;
  #log: LogEntry[] = [];
  #misses = 0;
  #locked = false;
  /** The wrong codes already counted, so a repost is not counted twice. */
  readonly #missed = new Set<string>();
  /** Requests whose seat ended and was forgotten. */
  readonly #closed = new Set<string>();
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
      secret: options.secret ?? newLinkSecret(),
      routes: routesSegment(options.routes ?? NO_ROUTES),
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
      locked: this.#locked,
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

  /** Run `fire` after `ms`, in place of whatever the seat was waiting on. */
  #arm(seat: Seat, ms: number, fire: () => void): void {
    if (seat.timer) clearTimeout(seat.timer);
    seat.timer = setTimeout(fire, ms);
  }

  #disarm(seat: Seat): void {
    if (seat.timer) clearTimeout(seat.timer);
    seat.timer = null;
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
    if (this.#ended) return { kind: "ended" };
    if (opened.kind === "not-a-request") return opened;
    // An open session has no code, so nothing was guessed: a request that
    // the link opens but the inner seal does not is not one, and no miss.
    if (opened.kind === "not-this-session")
      return this.code === null ? { kind: "not-a-request" } : this.#miss(text);
    const { request, joiner } = opened;
    const known = this.#seats.get(request.id);
    if (known) {
      // Asked again (a carrier dropped the reply): hand the same reply back.
      if (known.guest.reply && known.joiner === joiner)
        this.options.post?.(known.guest.reply);
      return { kind: "guest", key: request.id };
    }
    if (this.#closed.has(request.id)) return { kind: "not-a-request" };
    if (this.#locked) return { kind: "locked" };
    return this.#seat(request, joiner);
  }

  /** A wrong code from a link holder: counted once, and the fifth locks. */
  #miss(text: string): Received {
    if (this.#locked) return { kind: "locked" };
    // The same code again is a repost, not another guess.
    const seen = text.replace(/\s+/g, "");
    if (this.#missed.has(seen))
      return { kind: "not-this-session", misses: this.#misses };
    if (this.#missed.size < MISSED_MAX) this.#missed.add(seen);
    this.#misses += 1;
    if (this.#misses >= MAX_MISSES) this.#locked = true;
    this.#emit();
    return { kind: "not-this-session", misses: this.#misses };
  }

  async #seat(
    request: { id: string; name: string; note: string; offer: string },
    joiner: string,
  ): Promise<Received> {
    const seated = [...this.#seats.values()].filter((seat) =>
      OPEN.has(seat.guest.state),
    );
    if (seated.length >= MAX_GUESTS) return { kind: "full" };
    const key = request.id;
    const seat: Seat = {
      guest: {
        key,
        name: request.name,
        note: request.note,
        state: "asking",
        askedAt: this.#now(),
        reply: null,
      },
      offer: request.offer,
      joiner,
      peer: null,
      admitting: false,
      timer: null,
    };
    this.#seats.set(key, seat);
    this.#arm(seat, PAIRING_MS, () => this.#drop(key, "gone"));
    this.#emit();
    if (this.options.admission === "open") await this.admit(key);
    return { kind: "guest", key };
  }

  /** Let an asker in: only now is their offer answered. */
  async admit(key: string): Promise<void> {
    const seat = this.#seats.get(key);
    if (!seat || seat.guest.state !== "asking" || this.#ended) return;
    // `peer.open` waits on the browser: a second admit must not start beside it.
    if (seat.admitting) return;
    seat.admitting = true;
    const relay = this.options.relay?.(seatName(key)) ?? null;
    const peer = new HostPeer({
      relayed: relay !== null,
      guest: key,
      ice: this.options.ice,
      peers: this.options.peers,
      catalog: this.options.catalog,
      readField: this.options.readField,
      writeField: this.options.writeField,
      expiresAt: this.expiresAt,
      now: this.#now,
      onJoined: () => {
        if (seat.peer !== peer) return;
        this.#disarm(seat);
        this.#set(key, { state: "joined", reply: null });
      },
      onClosed: () => {
        if (seat.peer === peer) this.#drop(key, "gone");
      },
      onLog: (entry) => {
        this.#log = [...this.#log.slice(-199), entry];
        this.#emit();
      },
    });
    seat.peer = peer;
    try {
      const answer = await peer.open(seat.offer);
      if (relay)
        await peer.relayVia(relay, this.#owner, {
          link: this.link,
          code: this.code,
          joiner: seat.joiner,
          id: key,
        });
      const reply = await makeReplyCode(
        this.link,
        this.code,
        this.#owner,
        seat.joiner,
        relay ? { id: key, answer, relay: "nats" } : { id: key, answer },
      );
      if (seat.peer !== peer) {
        // Refused, ended or replaced while it was answering: nobody owns it.
        peer.close();
        return;
      }
      // The window to connect runs from the reply, not from the request.
      this.#arm(seat, PAIRING_MS, () => this.#drop(key, "gone"));
      this.#set(key, { state: "replied", reply });
      this.options.post?.(reply);
    } catch {
      peer.close();
      if (seat.peer === peer) this.#drop(key, "gone");
    } finally {
      seat.admitting = false;
    }
    // A receipt must not close the peer the joiner is about to use.
    if (seatState(this.#seats.get(key)) === "replied") {
      try {
        noteLiveSessionGranted(this.id, key);
      } catch {
        // The trail is best-effort. The admission stands.
      }
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
    // The offer is the seat's one big thing, and nothing reads it again.
    seat.offer = "";
    this.#arm(seat, SEAT_GRACE_MS, () => this.#forget(key));
    this.#set(key, { state, reply: null });
  }

  /** An ended seat leaves the list; its request is remembered, not seated again. */
  #forget(key: string): void {
    const seat = this.#seats.get(key);
    if (!seat || OPEN.has(seat.guest.state)) return;
    this.#seats.delete(key);
    this.#closed.add(key);
    if (this.#closed.size > CLOSED_MAX) {
      const oldest = this.#closed.values().next().value;
      if (oldest !== undefined) this.#closed.delete(oldest);
    }
    this.#emit();
  }

  /** End the session for everyone. */
  end(because: NonNullable<HostState["endedBecause"]> = "owner"): void {
    if (this.#ended) return;
    this.#ended = because;
    if (this.#timer) clearTimeout(this.#timer);
    for (const seat of this.#seats.values()) {
      this.#disarm(seat);
      seat.peer?.close();
      seat.peer = null;
      if (OPEN.has(seat.guest.state))
        seat.guest = { ...seat.guest, state: "gone", reply: null };
    }
    this.#emit();
  }
}
