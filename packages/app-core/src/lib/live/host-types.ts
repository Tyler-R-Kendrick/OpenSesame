/**
 * The shapes of a hosted live session (ADR 0150): who is in it, what its owner
 * sees, what pasting a code did, and what a session is started with. Split
 * from `host.ts` for the module-size budget (ADR 0093); `host.ts` re-exports
 * every name unchanged.
 */

import type { ConnectionPort } from "./connection-port.js";
import type { ResetBrokerOptions } from "./device-reset-broker.js";
import type { ResetDevicesState } from "./device-reset-types.js";
import type { DeviceLog, DevicesState } from "./device-types.js";
import type { HostPeer, LogEntry, ReadField, WriteField } from "./host-peer.js";
import type { IcePhase } from "./ice-diagnostics.js";
import type { Catalog, JoinRequest, SeatKind, SeatRoute } from "./messages.js";
import type { PeerTransport } from "./p2p.js";
import type { SeatPeerTrust, TrustGuestFields } from "./peer-trust-join.js";
import type { Carrier } from "./rendezvous.js";
import type { LiveRoutes } from "./routes.js";

export const MAX_MISSES = 5;
export const MAX_GUESTS = 8;
/** How long a seat that has ended stays listed before it is forgotten. */
export const SEAT_GRACE_MS = 60_000;
export const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
/** How many distinct wrong codes are remembered; each still counts as a miss. */
export const MISSED_MAX = 256;
/** How many forgotten requests are remembered, so a repost is not seated again. */
export const CLOSED_MAX = 256;

export type Admission = "invite" | "open";

export type GuestState = "asking" | "replied" | "joined" | "refused" | "gone";

export type GuestConnection = Readonly<{
  phase: IcePhase;
  detail: string;
}>;

export type Guest = Readonly<{
  /** The request id. */
  key: string;
  name: string;
  note: string;
  state: GuestState;
  askedAt: number;
  /** The reply code to hand back, once the owner has let them in. */
  reply: string | null;
  /** A person sees shared items; a device may ask to use connections (ADR 0196). */
  kind: SeatKind;
  /** Session SAS, once the request bound a handshake. */
  sas?: string | undefined;
  unverified?: boolean | undefined;
  /** Short key id, so two askers with one name can be told apart. */
  keyId?: string | undefined;
  nameClash?: boolean | undefined;
  peerFingerprint?: string | undefined;
  peerEpoch?: number | undefined;
  /** While the browsers meet after a reply was handed back (P8-3). */
  connection?: GuestConnection | undefined;
}>;

export type HostState = Readonly<{
  status: "live" | "ended";
  endedBecause: "owner" | "expired" | null;
  guests: readonly Guest[];
  log: readonly LogEntry[];
  misses: number;
  /** Too many wrong codes: no new request is taken; the people in stay. */
  locked: boolean;
  /** Devices asking for, or holding, a grant of the owner's connections. */
  devices: DevicesState;
  resets: ResetDevicesState;
}>;

/** What pasting one request code did. */
export type Received =
  /** Not a request for this session, or one that has already closed. */
  | Readonly<{ kind: "not-a-request" }>
  | Readonly<{ kind: "not-this-session"; misses: number }>
  /** The session is locked: it takes no new request. */
  | Readonly<{ kind: "locked" }>
  | Readonly<{ kind: "full" }>
  /** A device asked, and this session does not let devices use connections. */
  | Readonly<{ kind: "no-devices" }>
  /** The request names a relay route, and this session offers no relay. */
  | Readonly<{ kind: "no-relay" }>
  | Readonly<{ kind: "ended" }>
  | Readonly<{ kind: "duplicate" }>
  | Readonly<{ kind: "guest"; key: string }>;

export type HostOptions = Readonly<{
  admission: Admission;
  /** What carries each seat, over the owner's routes. */
  transport: PeerTransport;
  /** Epoch ms; clamped to seven days from now. */
  expiresAt: number;
  catalog: () => Catalog;
  readField: ReadField;
  /** Present when the session may write a shared field back. Absent denies. */
  writeField?: WriteField | undefined;
  /** What the link carries for joiners: ICE servers, relay only, carriers. */
  routes?: LiveRoutes;
  /** Where a reply code goes besides the owner's screen (a carrier). */
  post?: (code: string) => void;
  /** A seat's channel on a NATS carrier, or null; asked at each admission. */
  relay?: (name: string) => Carrier | null;
  /** The link secret, when the caller minted credentials for its topic. */
  secret?: string;
  /** Whether a relay (a NATS carrier) could carry a seat now. */
  canRelay?: () => boolean;
  /** Create the joined person and the session's shares when a seat is admitted. */
  provisionSeat?: (guest: Guest, hostId: string) => Promise<void> | void;
  /**
   * Present when devices may ask to use the owner's connections (ADR 0196):
   * where the connections are. Absent, a device's request is not seated.
   */
  devices?: Readonly<{ port: () => ConnectionPort | null }> | undefined;
  /** Exact reset capabilities a device may ask the owner to approve. */
  resets?: Pick<ResetBrokerOptions, "items"> | undefined;
  now?: () => number;
}>;

/** What the host keeps of one seat: the guest as shown, and how it connects. */
export type HostSeat = {
  guest: Guest;
  offer: string;
  /** The joiner greets until it holds the catalog (ADR 0186). */
  greets: boolean;
  /** The joiner's public key: its reply is sealed to it. */
  joiner: string;
  kind: SeatKind;
  route: SeatRoute;
  peer: HostPeer | null;
  /** An admit is waiting on its peer's answer: a second must not start. */
  admitting: boolean;
  /** Set when the request bound peer trust; the reply stays sealed until compare. */
  peerTrust: SeatPeerTrust | null;
  /** The seat's expiry while it waits, or its removal once it has ended. */
  timer: ReturnType<typeof setTimeout> | null;
};

/** Run `fire` after `ms`, replacing the seat's previous timer. */
export function armSeatTimer(
  seat: HostSeat,
  ms: number,
  fire: () => void,
): void {
  if (seat.timer) clearTimeout(seat.timer);
  seat.timer = setTimeout(fire, ms);
}

/** A joined or ended seat has no outstanding admission timer. */
export function disarmSeatTimer(seat: HostSeat): void {
  if (seat.timer) clearTimeout(seat.timer);
  seat.timer = null;
}

/** The states in which a seat still counts toward the session's eight. */
export const OPEN: ReadonlySet<GuestState> = new Set<GuestState>([
  "asking",
  "replied",
  "joined",
]);

/** A seat for an asker whose request has just been seated. */
export function askingSeat(
  request: JoinRequest,
  joiner: string,
  kind: SeatKind,
  route: SeatRoute,
  askedAt: number,
  trust: TrustGuestFields,
  peerTrust: SeatPeerTrust | null,
): HostSeat {
  return {
    guest: {
      key: request.id,
      name: request.name,
      note: request.note,
      state: "asking",
      askedAt,
      reply: null,
      kind,
      ...trust,
    },
    offer: request.offer,
    greets: request.greets,
    joiner,
    kind,
    route,
    peer: null,
    admitting: false,
    timer: null,
    peerTrust,
  };
}

/** The state a seat contributes to the owner's view. */
export const seatState = (seat: HostSeat | undefined) => seat?.guest.state;

/** Project device metadata into the owner's log without carrying a value. */
export function deviceLogEntry(entry: DeviceLog): LogEntry {
  return {
    at: entry.at,
    guest: entry.guest,
    what: entry.what,
    item: entry.connection,
    field: entry.operation,
  };
}
