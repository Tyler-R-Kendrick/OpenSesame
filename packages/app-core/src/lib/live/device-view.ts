/**
 * What the owner's screen is told of device authorization (ADR 0196): the
 * requests waiting, and the grants standing — ids, names, codes and times.
 * Never a device code, which only the device holds.
 */

import type {
  DeviceGrant,
  DevicesState,
  Grant,
  Pending,
  PendingDevice,
  Seat,
} from "./device-types.js";

function pendingView(wait: Pending): PendingDevice {
  return {
    id: wait.id,
    seat: wait.seat.identity.key,
    name: wait.seat.identity.name,
    userCode: wait.userCode,
    want: wait.want,
    askedAt: wait.askedAt,
    expiresAt: wait.expiresAt,
  };
}

function grantView(grant: Grant): DeviceGrant {
  return {
    id: grant.id,
    seat: grant.seat.identity.key,
    name: grant.seat.identity.name,
    connections: [...grant.connections],
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    calls: grant.calls,
  };
}

/** The state the owner sees: oldest first, a lapsed request not among them. */
export function devicesState(seats: Iterable<Seat>): DevicesState {
  const pending: PendingDevice[] = [];
  const grants: DeviceGrant[] = [];
  for (const seat of seats) {
    if (seat.pending?.outcome === "waiting")
      pending.push(pendingView(seat.pending));
    if (seat.grant) grants.push(grantView(seat.grant));
  }
  return {
    pending: pending.sort((a, b) => a.askedAt - b.askedAt),
    grants: grants.sort((a, b) => a.grantedAt - b.grantedAt),
  };
}
