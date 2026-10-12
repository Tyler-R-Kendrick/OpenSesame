/**
 * The shapes of device authorization in a live session (ADR 0195): what the
 * owner's screen is told, what a seat's end of the broker looks like, and the
 * records the broker keeps while a session runs. Split from the broker for
 * the module-size budget (ADR 0093).
 */

import type { DeviceReply, DeviceRequest } from "./device-messages.js";

/** How long a request may wait for the owner. */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;
/** RFC 8628 §3.2's default wait between polls, and §3.5's increment. */
export const POLL_SECONDS = 5;
export const SLOW_DOWN_STEP = 5;
export const MAX_POLL_SECONDS = 60;
/** Requests waiting at once, across the session. */
export const MAX_PENDING = 8;
/** A seat may start a new request no sooner than this after its last. */
export const BEGIN_GAP_MS = 2000;
/** Calls running at once, and calls a minute, for one grant. */
export const MAX_IN_FLIGHT = 4;
export const CALLS_PER_MINUTE = 60;
export const GRANT_MINUTES_MAX = 8 * 60;

export type PendingDevice = Readonly<{
  /** The owner's handle on the request. Not the device code. */
  id: string;
  /** The seat that asked. */
  seat: string;
  name: string;
  /** What the owner compares with the device's screen. */
  userCode: string;
  /** Connections the device named in its request: a hint, never a grant. */
  want: readonly string[];
  askedAt: number;
  expiresAt: number;
}>;

export type DeviceGrant = Readonly<{
  id: string;
  seat: string;
  name: string;
  connections: readonly string[];
  grantedAt: number;
  expiresAt: number;
  /** Calls answered so far. */
  calls: number;
}>;

export type DevicesState = Readonly<{
  pending: readonly PendingDevice[];
  grants: readonly DeviceGrant[];
}>;

export const NO_DEVICES: DevicesState = { pending: [], grants: [] };

/** One line for the owner's log: ids and operation names, never a value. */
export type DeviceLog = Readonly<{
  at: number;
  guest: string;
  what: "invoke" | "denied";
  connection: string;
  operation: string;
}>;

export type SeatIdentity = Readonly<{ key: string; name: string }>;

/** One seat's end of the broker: its requests in, its replies out. */
export type SeatDevices = Readonly<{
  handle(request: DeviceRequest): Promise<void>;
  /** The seat is gone: whatever it asked for or was given goes with it. */
  close(): void;
}>;

export type Approval = Readonly<{
  connections: readonly string[];
  /** Minutes the grant lasts; clamped to the session's end. */
  minutes: number;
}>;

export type ApproveResult =
  | "approved"
  | "unknown"
  | "lapsed"
  | "nothing_chosen"
  | "unavailable";

/** The broker's record of one seat. */
export type Seat = {
  readonly identity: SeatIdentity;
  readonly send: (reply: DeviceReply) => void;
  pending: Pending | null;
  grant: Grant | null;
};

export type Pending = {
  readonly id: string;
  readonly seat: Seat;
  readonly req: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly want: readonly string[];
  readonly askedAt: number;
  readonly expiresAt: number;
  interval: number;
  nextPollAt: number;
  outcome: "waiting" | "approved" | "denied";
  timer: ReturnType<typeof setTimeout> | null;
};

export type Grant = {
  readonly id: string;
  readonly seat: Seat;
  readonly connections: ReadonlySet<string>;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly ended: AbortController;
  calls: number;
  inFlight: number;
  recent: number[];
  timer: ReturnType<typeof setTimeout> | null;
};
