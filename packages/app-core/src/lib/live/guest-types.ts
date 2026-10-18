/**
 * The shapes of the joiner's side of a live session (ADR 0150, ADR 0196).
 * Split from `guest.ts` for the module-size budget (ADR 0093); `guest.ts`
 * re-exports every name unchanged.
 */

import type { IceDiagnosticView } from "./ice-diagnostics.js";
import type { LiveLink } from "./link.js";
import type { Catalog, SeatKind, SeatRoute } from "./messages.js";
import type { NatsSession } from "./nats-route.js";
import type { PeerRouting, PeerTransport } from "./p2p.js";
import type { JoinPeerMaterial } from "./peer-trust-join.js";
import type { Carrier } from "./rendezvous.js";

/** How often an unanswered request is posted again on the carriers. */
export const REPOST_MS = 20_000;
export const REPOSTS = 30;

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
  | Readonly<{
      at: "request";
      code: string;
      sas?: string;
      unverified?: boolean;
    }>
  | Readonly<{
      at: "connecting";
      since: number;
      ice?: IceDiagnosticView;
    }>
  /** No catalog in time: the link is closed, and the person may ask again. */
  | Readonly<{ at: "connect_timeout" }>
  | Readonly<{ at: "joined"; catalog: Catalog }>
  /** The browsers found no route to each other. */
  | Readonly<{ at: "unreachable"; reason: string }>
  | Readonly<{ at: "ended" }>;

export type GuestOptions = Readonly<{
  link: LiveLink;
  /** The normalized code for an invite session; null for an open one. */
  code: string | null;
  name: string;
  note: string;
  /**
   * What carries the session, over the routes the person agreed to. Null on a
   * relay route, which has no peer connection at all.
   */
  transport: PeerTransport | null;
  /** How this attempt may reach the owner; used for ICE failure copy. */
  routing?: PeerRouting;
  carriers?: GuestCarriers | null;
  now?: () => number;
  /** Who is asking: a person (the default) or a device (ADR 0196). */
  kind?: SeatKind;
  /**
   * `relay`: no offer is made and the seat is carried over the owner's NATS
   * server alone, for a client with no WebRTC (a terminal). Default `peer`.
   */
  route?: SeatRoute;
  /** Channel binding for this join. Absent keeps the legacy request. */
  peerTrust?: JoinPeerMaterial | null;
}>;
