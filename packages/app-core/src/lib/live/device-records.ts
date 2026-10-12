/**
 * The two records a broker keeps for a seat (ADR 0195): a request waiting on
 * the owner, and the grant the owner's allowing makes of it. Built here, the
 * timers left to the broker that owns their lifetimes.
 */

import {
  DEVICE_CODE_TTL_MS,
  type Grant,
  POLL_SECONDS,
  type Pending,
  type Seat,
} from "./device-types.js";
import { newRequestId } from "./seal.js";

/** A request a seat has just made, waiting on the owner. */
export function pendingFor(
  seat: Seat,
  ask: Readonly<{ req: string; want: readonly string[]; userCode: string }>,
  now: number,
  sessionEnds: number,
): Pending {
  return {
    id: newRequestId(),
    seat,
    req: ask.req,
    deviceCode: newRequestId(),
    userCode: ask.userCode,
    want: ask.want,
    askedAt: now,
    expiresAt: Math.min(now + DEVICE_CODE_TTL_MS, sessionEnds),
    interval: POLL_SECONDS,
    nextPollAt: now + POLL_SECONDS * 1000,
    outcome: "waiting",
    timer: null,
  };
}

/** What the owner's allowing makes of a request: no longer than the session. */
export function grantFor(
  seat: Seat,
  connections: readonly string[],
  minutes: number,
  now: number,
  sessionEnds: number,
): Grant {
  return {
    id: newRequestId(),
    seat,
    connections: new Set(connections),
    grantedAt: now,
    expiresAt: Math.min(now + minutes * 60_000, sessionEnds),
    ended: new AbortController(),
    calls: 0,
    inFlight: 0,
    recent: [],
    timer: null,
  };
}
