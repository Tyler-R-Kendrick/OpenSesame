/** The owner's side of a live session (ADR 0150). A peer-trust ask waits for the SAS. */
import { noteLiveSessionGranted } from "../sharing-receipts.js";
import type { DeviceBroker } from "./device-broker.js";
import type { DeviceResetBroker } from "./device-reset-broker.js";
import { NO_RESET_DEVICES } from "./device-reset-types.js";
import { NO_DEVICES } from "./device-types.js";
import {
  createSessionDeviceBrokers,
  deviceSeatRouter,
} from "./host-device-router.js";
import { HostPeer, type LogEntry } from "./host-peer.js";
import {
  CLOSED_MAX,
  type Guest,
  type HostOptions,
  type HostState,
  MAX_GUESTS,
  MAX_MISSES,
  MAX_SESSION_MS,
  MISSED_MAX,
  OPEN,
  type Received,
  SEAT_GRACE_MS,
  type HostSeat as Seat,
  armSeatTimer,
  askingSeat,
  deviceLogEntry,
  disarmSeatTimer,
  seatState,
} from "./host-types.js";
import type { LiveLink } from "./link.js";
import type { JoinRequest } from "./messages.js";
import { withNamedAddresses } from "./named-addresses.js";
import { PAIRING_MS } from "./p2p.js";
import { makeReplyCode, openRequestCode } from "./pairing.js";
import { judgeJoinPeer, replyForSeat } from "./peer-trust-join.js";
import type { Carrier } from "./rendezvous.js";
import { NO_ROUTES, routesSegment } from "./routes.js";
import { type Keypair, newCode, newKeypair, newLinkSecret } from "./seal.js";
import { seatName } from "./seat-channel.js";
// What a host is made of lives in `host-types.ts`; it is named here as well.
export * from "./host-types.js";
/** One live session, hosted by this tab. */
export class LiveHost {
  readonly link: LiveLink;
  readonly id = crypto.randomUUID();
  readonly code: string | null;
  readonly expiresAt: number;
  readonly devices: DeviceBroker | null;
  readonly resets: DeviceResetBroker | null;
  readonly #owner: Keypair;
  readonly #seats = new Map<string, Seat>();
  readonly #listeners = new Set<(state: HostState) => void>();
  readonly #now: () => number;
  #log: LogEntry[] = [];
  #misses = 0;
  #locked = false;
  readonly #missed = new Set<string>();
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
    const brokers = createSessionDeviceBrokers(
      options,
      this.expiresAt,
      this.#now,
      (entry) => this.#record(deviceLogEntry(entry)),
      () => this.#emit(),
    );
    this.devices = brokers.devices;
    this.resets = brokers.resets;
  }
  #record(entry: LogEntry): void {
    this.#log = [...this.#log.slice(-199), entry];
    this.#emit();
  }
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
      devices: this.devices?.state ?? NO_DEVICES,
      resets: this.resets?.state ?? NO_RESET_DEVICES,
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

  async receive(text: string): Promise<Received> {
    if (this.#ended) return { kind: "ended" };
    const opened = await openRequestCode(
      this.link,
      this.code,
      this.#owner,
      text,
      this.options.transport.readsOffer,
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

  async #seat(request: JoinRequest, joiner: string): Promise<Received> {
    const kind = request.kind ?? "person";
    const route = request.route ?? "peer";
    // A device is seated only where devices may ask, and a relay-only request
    // only where a relay could carry it: say so now, not after a long wait.
    if (kind === "device" && !this.devices && !this.resets)
      return { kind: "no-devices" };
    if (route === "relay" && !(this.options.canRelay?.() ?? false))
      return { kind: "no-relay" };
    const open = [...this.#seats.values()].filter((seat) =>
      OPEN.has(seat.guest.state),
    );
    if (open.length >= MAX_GUESTS) return { kind: "full" };
    const judged = await judgeJoinPeer(
      request,
      joiner,
      open.map((seat) => ({
        key: seat.guest.key,
        name: seat.guest.name,
        fingerprint: seat.guest.peerFingerprint ?? "",
      })),
    );
    if (!judged.ok) {
      return judged.reason === "duplicate"
        ? { kind: "duplicate" }
        : { kind: "not-a-request" };
    }
    const key = request.id;
    const seat = askingSeat(
      request,
      joiner,
      kind,
      route,
      this.#now(),
      judged.guest,
      judged.peerTrust,
    );
    this.#seats.set(key, seat);
    for (const id of judged.clashKeys) this.#set(id, { nameClash: true });
    armSeatTimer(seat, PAIRING_MS, () => this.#drop(key, "gone"));
    this.#emit();
    // An open session's link is the admission: let the holder in at once.
    // The SAS stays on the owner's row for an optional check, but it does not
    // hold the reply. Invite sessions still wait for that compare.
    if (this.options.admission === "open") {
      await this.admit(key);
    }
    return { kind: "guest", key };
  }

  #peerFor(key: string, seat: Seat, relay: Carrier | null): HostPeer {
    // A device is built a peer that has no vault to read from: an empty
    // catalog, nothing to reveal and nothing to write. The peer refuses a
    // device the same things on its own account, but a future message that
    // reads the vault finds nothing here to read, whatever it forgot to check.
    const device = seat.kind === "device";
    const peer: HostPeer = new HostPeer({
      relayed: relay !== null,
      route: seat.route,
      kind: seat.kind,
      name: seat.guest.name,
      devices: {
        seat: (identity, send) =>
          deviceSeatRouter(identity, send, this.devices, this.resets),
      },
      guest: key,
      transport: this.options.transport,
      greets: seat.greets,
      catalog: device
        ? () => ({ ...this.options.catalog(), items: [] })
        : this.options.catalog,
      readField: device ? async () => null : this.options.readField,
      writeField: device ? undefined : this.options.writeField,
      expiresAt: this.expiresAt,
      now: this.#now,
      onJoined: () => {
        if (seat.peer !== peer) return;
        disarmSeatTimer(seat);
        this.#set(key, { state: "joined", reply: null });
      },
      onClosed: () => {
        if (seat.peer === peer) this.#drop(key, "gone");
      },
      onLog: (entry) => this.#record(entry),
      onConnection: (connection) => {
        if (seat.peer !== peer) return;
        const guest = this.#seats.get(key)?.guest;
        if (!guest || guest.state !== "replied") return;
        this.#set(key, { connection: connection ?? undefined });
      },
    });
    return peer;
  }

  #admission(
    key: string,
  ): Readonly<{ seat: Seat; relay: Carrier | null }> | null {
    const seat = this.#seats.get(key);
    if (!seat || seat.guest.state !== "asking" || this.#ended) return null;
    if (seat.admitting) return null;
    const relay = this.options.relay?.(seatName(key)) ?? null;
    if (seat.route === "relay" && !relay) {
      this.#drop(key, "gone");
      return null;
    }
    seat.admitting = true;
    return { seat, relay };
  }

  /** Let an asker in: only now is their offer answered. */
  async admit(key: string): Promise<void> {
    const admission = this.#admission(key);
    if (!admission) return;
    const { seat, relay } = admission;
    if (this.options.provisionSeat) {
      try {
        await this.options.provisionSeat(seat.guest, this.id);
      } catch {
        this.#drop(key, "refused");
        return;
      }
      if (
        this.#ended ||
        this.#seats.get(key) !== seat ||
        seat.guest.state !== "asking"
      )
        return;
    }
    const peer = this.#peerFor(key, seat, relay);
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
      const body = await replyForSeat(
        key,
        answer,
        relay !== null,
        seat.peerTrust,
      );
      if (!body) throw new Error("peer_trust_reply");
      const reply = await makeReplyCode(
        this.link,
        this.code,
        this.#owner,
        seat.joiner,
        withNamedAddresses(body, this.options.transport.named),
      );
      if (seat.peer !== peer) {
        // Refused, ended or replaced while it was answering: nobody owns it.
        peer.close();
        return;
      }
      // The window to connect runs from the reply, not from the request.
      armSeatTimer(seat, PAIRING_MS, () => this.#drop(key, "gone"));
      this.#set(key, { state: "replied", reply, connection: undefined });
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

  /** Push the current vault catalog to every joined seat. */
  refreshCatalog(): void {
    for (const seat of this.#seats.values()) seat.peer?.refreshCatalog();
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
    armSeatTimer(seat, SEAT_GRACE_MS, () => this.#forget(key));
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
    this.devices?.end();
    this.resets?.end();
    for (const seat of this.#seats.values()) {
      disarmSeatTimer(seat);
      seat.peer?.close();
      seat.peer = null;
      if (OPEN.has(seat.guest.state))
        seat.guest = { ...seat.guest, state: "gone", reply: null };
    }
    this.#emit();
  }
}
