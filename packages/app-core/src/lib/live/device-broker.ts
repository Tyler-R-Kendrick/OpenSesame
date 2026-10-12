/**
 * The owner's side of device authorization in a live session (ADR 0195).
 *
 * A device that holds the link and has been let in asks for authority
 * (RFC 8628, the device authorization grant): it is handed a **device code**
 * to poll with and a **user code** the owner compares on their own screen.
 * Nothing is granted until the owner picks the connections and presses allow;
 * then the device may name those connections, and only those, until the grant
 * lapses, the owner revokes it, the seat goes, or the session ends.
 *
 * The seat's sealed channel is what authenticates the device, so a grant is
 * bound to its seat and is not a bearer: there is no token to copy out, log or
 * replay from another seat. A device that reconnects is a new seat and asks
 * again. The broker keeps nothing in storage.
 */

import type { ConnectionPort } from "./connection-port.js";
import { revealsSecret } from "./connection-port.js";
import type {
  DeviceAuthState,
  DeviceConnection,
  DeviceReply,
  DeviceRequest,
} from "./device-messages.js";
import {
  type Approval,
  type ApproveResult,
  DEVICE_CODE_TTL_MS,
  type DeviceLog,
  type DevicesState,
  GRANT_MINUTES_MAX,
  type Grant,
  MAX_PENDING,
  MAX_POLL_SECONDS,
  POLL_SECONDS,
  type Pending,
  SLOW_DOWN_STEP,
  type Seat,
  type SeatDevices,
  type SeatIdentity,
} from "./device-types.js";
import { type UseContext, answerCall } from "./device-use.js";
import { devicesState } from "./device-view.js";
import { newCode, newRequestId } from "./seal.js";

export type BrokerOptions = Readonly<{
  /** The port as it stands now; null while nothing can be used. */
  port: () => ConnectionPort | null;
  /** When the session ends, epoch ms: no grant outlives it. */
  expiresAt: number;
  now?: () => number;
  onLog: (entry: DeviceLog) => void;
}>;

export class DeviceBroker {
  readonly #options: BrokerOptions;
  readonly #seats = new Map<string, Seat>();
  readonly #listeners = new Set<(state: DevicesState) => void>();
  readonly #now: () => number;
  readonly #use: UseContext;
  #over = false;

  constructor(options: BrokerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#use = {
      port: options.port,
      now: this.#now,
      over: () => this.#over,
      log: options.onLog,
      changed: () => this.#emit(),
    };
  }

  get state(): DevicesState {
    return devicesState(this.#seats.values());
  }

  subscribe(listener: (state: DevicesState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const state = this.state;
    for (const listener of [...this.#listeners]) listener(state);
  }

  /** The connections a device could be granted now, as the port lists them. */
  offered(): readonly DeviceConnection[] {
    return (this.#options.port()?.list() ?? []).map((held) => ({
      ...held,
      operations: held.operations.filter((entry) => !revealsSecret(entry)),
    }));
  }

  /** A seat's end: its replies go out through `send`. */
  seat(
    identity: SeatIdentity,
    send: (reply: DeviceReply) => void,
  ): SeatDevices {
    const seat: Seat = { identity, send, pending: null, grant: null };
    if (!this.#over) this.#seats.set(identity.key, seat);
    return {
      handle: (request) => this.#handle(seat, request),
      close: () => this.#leave(seat),
    };
  }

  async #handle(seat: Seat, request: DeviceRequest): Promise<void> {
    if (this.#over || this.#seats.get(seat.identity.key) !== seat) return;
    switch (request.t) {
      case "dev.begin":
        this.#begin(seat, request.req, request.want);
        return;
      case "dev.poll":
        this.#poll(seat, request.req, request.deviceCode);
        return;
      case "dev.list":
        this.#list(seat, request.req);
        return;
      case "dev.call": {
        const grant = this.#live(seat);
        if (typeof grant === "string")
          return seat.send({ t: "dev.error", req: request.req, error: grant });
        await answerCall(this.#use, seat, grant, request);
      }
    }
  }

  // --- asking -----------------------------------------------------------

  #begin(seat: Seat, req: string, want: readonly string[]): void {
    const waiting = [...this.#seats.values()].filter(
      (other) => other !== seat && other.pending?.outcome === "waiting",
    );
    if (waiting.length >= MAX_PENDING || this.offered().length === 0) {
      seat.send({ t: "dev.error", req, error: "temporarily_unavailable" });
      return;
    }
    // One question at a time from a seat: a new one replaces the old.
    this.#settle(seat.pending);
    const now = this.#now();
    const pending: Pending = {
      id: newRequestId(),
      seat,
      req,
      deviceCode: newRequestId(),
      userCode: this.#freshCode(),
      want,
      askedAt: now,
      expiresAt: Math.min(now + DEVICE_CODE_TTL_MS, this.#options.expiresAt),
      interval: POLL_SECONDS,
      nextPollAt: now + POLL_SECONDS * 1000,
      outcome: "waiting",
      timer: null,
    };
    pending.timer = setTimeout(
      () => this.#lapse(pending),
      Math.max(0, pending.expiresAt - now),
    );
    seat.pending = pending;
    seat.send({
      t: "dev.code",
      req,
      deviceCode: pending.deviceCode,
      userCode: pending.userCode,
      expiresIn: Math.max(1, Math.ceil((pending.expiresAt - now) / 1000)),
      interval: POLL_SECONDS,
    });
    this.#emit();
  }

  /** A user code no other request in this session holds. */
  #freshCode(): string {
    const taken = new Set<string>();
    for (const other of this.#seats.values())
      if (other.pending) taken.add(other.pending.userCode);
    let code = newCode();
    while (taken.has(code)) code = newCode();
    return code;
  }

  #lapse(pending: Pending): void {
    if (pending.seat.pending !== pending || pending.outcome !== "waiting")
      return;
    pending.outcome = "denied";
    pending.timer = null;
    this.#emit();
  }

  /** Forget a request: its timer stops, and the owner's list drops it. */
  #settle(pending: Pending | null): void {
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    if (pending.seat.pending === pending) pending.seat.pending = null;
  }

  #poll(seat: Seat, req: string, deviceCode: string): void {
    const pending = seat.pending;
    if (!pending || pending.deviceCode !== deviceCode) {
      seat.send({ t: "dev.error", req, error: "invalid_request" });
      return;
    }
    const now = this.#now();
    if (now < pending.nextPollAt) {
      // Too soon (RFC 8628 §3.5): wait longer, and say how much longer.
      pending.interval = Math.min(
        MAX_POLL_SECONDS,
        pending.interval + SLOW_DOWN_STEP,
      );
      pending.nextPollAt = now + pending.interval * 1000;
      seat.send({
        t: "dev.auth",
        req,
        state: "slow_down",
        interval: pending.interval,
      });
      return;
    }
    pending.nextPollAt = now + pending.interval * 1000;
    seat.send(this.#standing(pending, req, now));
  }

  /** Where a request stands, as the device is told. */
  #standing(pending: Pending, req: string, now: number): DeviceReply {
    const { seat } = pending;
    if (pending.outcome === "approved")
      // Granted once; if the grant has since ended, the code is spent.
      return seat.grant
        ? this.#granted(seat.grant, req)
        : { t: "dev.auth", req, state: "expired_token" };
    const lapsed = now >= pending.expiresAt;
    let state: DeviceAuthState = "authorization_pending";
    if (lapsed) state = "expired_token";
    else if (pending.outcome === "denied") state = "access_denied";
    return { t: "dev.auth", req, state };
  }

  // --- the owner's answer ----------------------------------------------

  approve(id: string, approval: Approval): ApproveResult {
    const pending = this.#find(id);
    if (!pending || this.#over) return "unknown";
    const now = this.#now();
    if (pending.outcome !== "waiting" || now >= pending.expiresAt)
      return "lapsed";
    const port = this.#options.port();
    if (!port) return "unavailable";
    const held = new Set(port.list().map((entry) => entry.id));
    const chosen = [...new Set(approval.connections)].filter((entry) =>
      held.has(entry),
    );
    if (chosen.length === 0) return "nothing_chosen";
    const minutes = Math.min(
      GRANT_MINUTES_MAX,
      Math.max(1, Math.floor(approval.minutes)),
    );
    const { seat } = pending;
    this.#endGrant(seat.grant);
    const grant: Grant = {
      id: newRequestId(),
      seat,
      connections: new Set(chosen),
      grantedAt: now,
      expiresAt: Math.min(now + minutes * 60_000, this.#options.expiresAt),
      ended: new AbortController(),
      calls: 0,
      inFlight: 0,
      recent: [],
      timer: null,
    };
    grant.timer = setTimeout(
      () => this.#endGrant(grant),
      Math.max(0, grant.expiresAt - now),
    );
    seat.grant = grant;
    pending.outcome = "approved";
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    seat.send(this.#granted(grant, pending.req));
    this.#emit();
    return "approved";
  }

  deny(id: string): boolean {
    const pending = this.#find(id);
    if (!pending || pending.outcome !== "waiting") return false;
    pending.outcome = "denied";
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    pending.seat.send({
      t: "dev.auth",
      req: pending.req,
      state: "access_denied",
    });
    this.#emit();
    return true;
  }

  revoke(grantId: string): boolean {
    for (const seat of this.#seats.values()) {
      if (seat.grant?.id !== grantId) continue;
      this.#endGrant(seat.grant);
      return true;
    }
    return false;
  }

  #find(id: string): Pending | null {
    for (const seat of this.#seats.values())
      if (seat.pending?.id === id) return seat.pending;
    return null;
  }

  #granted(grant: Grant, req: string): DeviceReply {
    return {
      t: "dev.auth",
      req,
      state: "granted",
      expiresAt: grant.expiresAt,
      connections: this.#covered(grant),
    };
  }

  /** What a grant covers that still exists, as the port lists it now. */
  #covered(grant: Grant): readonly DeviceConnection[] {
    return this.offered().filter((entry) => grant.connections.has(entry.id));
  }

  #endGrant(grant: Grant | null): void {
    if (!grant) return;
    if (grant.timer) clearTimeout(grant.timer);
    grant.timer = null;
    grant.ended.abort();
    if (grant.seat.grant === grant) grant.seat.grant = null;
    this.#emit();
  }

  // --- using a grant ------------------------------------------------------

  #list(seat: Seat, req: string): void {
    const grant = this.#live(seat);
    if (typeof grant === "string")
      seat.send({ t: "dev.error", req, error: grant });
    else seat.send({ t: "dev.conns", req, connections: this.#covered(grant) });
  }

  /** The seat's grant if it stands, else why not. */
  #live(seat: Seat): Grant | "access_denied" | "expired_token" {
    const grant = seat.grant;
    if (!grant) return "access_denied";
    if (this.#now() >= grant.expiresAt) {
      this.#endGrant(grant);
      return "expired_token";
    }
    return grant;
  }

  // --- leaving ------------------------------------------------------------

  #leave(seat: Seat): void {
    if (this.#seats.get(seat.identity.key) !== seat) return;
    this.#settle(seat.pending);
    this.#endGrant(seat.grant);
    this.#seats.delete(seat.identity.key);
    this.#emit();
  }

  /** The session is over: every request and grant ends with it. */
  end(): void {
    if (this.#over) return;
    this.#over = true;
    for (const seat of this.#seats.values()) {
      this.#settle(seat.pending);
      this.#endGrant(seat.grant);
    }
    this.#seats.clear();
    this.#emit();
  }
}
