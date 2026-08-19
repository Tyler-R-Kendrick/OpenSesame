import type {
  DeviceAuthorizationSession,
  DeviceAuthorizationState,
} from "@opensesame/os-domain";
import {
  maybeExpireDeviceAuth,
  recordDevicePoll,
  type Clock,
} from "@opensesame/os-domain";

/** RFC 8628 token endpoint error codes for device flow. */
export type DevicePollError =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  /** The device code was already redeemed; it is single use. */
  | "invalid_grant";

export interface DeviceAuthProjection {
  id: string;
  clientId: string;
  state: DeviceAuthorizationState;
  intervalSeconds: number;
  pollCount: number;
  expiresAt: string;
  approvedByPrincipalId?: string;
  /** Safe for UI/audit — never includes codes/tokens. */
  auditSummary: string;
}

export function projectDeviceAuth(
  session: DeviceAuthorizationSession,
): DeviceAuthProjection {
  const projection: DeviceAuthProjection = {
    id: session.id,
    clientId: session.clientId,
    state: session.state,
    intervalSeconds: session.intervalSeconds,
    pollCount: session.pollCount,
    expiresAt: session.expiresAt.toISOString(),
    auditSummary: `device_auth:${session.id}:${session.state}`,
  };
  if (session.approvedByPrincipalId !== undefined) {
    projection.approvedByPrincipalId = session.approvedByPrincipalId;
  }
  return projection;
}

export interface PollIntervalState {
  intervalSeconds: number;
  slowDownCount: number;
}

export function initialPollInterval(intervalSeconds: number): PollIntervalState {
  return { intervalSeconds, slowDownCount: 0 };
}

/** Increase interval after slow_down (RFC 8628). A server may ask the
 * client to slow down; it may not ask it to stop polling. */
export const MAX_POLL_INTERVAL_SECONDS = 60;

export function applySlowDown(
  state: PollIntervalState,
  bumpSeconds = 5,
): PollIntervalState {
  return {
    intervalSeconds: Math.min(
      state.intervalSeconds + bumpSeconds,
      MAX_POLL_INTERVAL_SECONDS,
    ),
    slowDownCount: state.slowDownCount + 1,
  };
}

export function shouldSlowDown(
  session: DeviceAuthorizationSession,
  now: Date,
  minIntervalSeconds?: number,
): boolean {
  const interval = minIntervalSeconds ?? session.intervalSeconds;
  if (!session.lastPolledAt) {
    return false;
  }
  const elapsedMs = now.getTime() - session.lastPolledAt.getTime();
  return elapsedMs < interval * 1000;
}

export function evaluateDevicePoll(
  session: DeviceAuthorizationSession,
  clock: Clock = () => new Date(),
): {
  session: DeviceAuthorizationSession;
  error?: DevicePollError;
  projection: DeviceAuthProjection;
} {
  const now = clock();
  let current = maybeExpireDeviceAuth(session, clock);

  if (current.state === "expired") {
    return {
      session: current,
      error: "expired_token",
      projection: projectDeviceAuth(current),
    };
  }
  if (current.state === "denied") {
    return {
      session: current,
      error: "access_denied",
      projection: projectDeviceAuth(current),
    };
  }
  // A consumed device code must not poll clean, or a caller that reads "no
  // error" as "issue tokens" would mint a second set from one approval.
  if (current.state === "consumed") {
    return {
      session: current,
      error: "invalid_grant",
      projection: projectDeviceAuth(current),
    };
  }
  if (current.state === "approved") {
    return {
      session: current,
      projection: projectDeviceAuth(current),
    };
  }

  // pending
  if (shouldSlowDown(current, now)) {
    current = recordDevicePoll(current, now);
    return {
      session: current,
      error: "slow_down",
      projection: projectDeviceAuth(current),
    };
  }

  current = recordDevicePoll(current, now);
  return {
    session: current,
    error: "authorization_pending",
    projection: projectDeviceAuth(current),
  };
}
