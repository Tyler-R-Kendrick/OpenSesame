import { DomainError, invalidTransition } from "../errors.js";
import type {
  Clock,
  DeviceAuthorizationSession,
  DeviceAuthorizationState,
} from "../types.js";

const TERMINAL: ReadonlySet<DeviceAuthorizationState> = new Set([
  "denied",
  "expired",
  "consumed",
]);

const ALLOWED: ReadonlyMap<
  DeviceAuthorizationState,
  ReadonlySet<DeviceAuthorizationState>
> = new Map([
  ["pending", new Set(["approved", "denied", "expired"])],
  ["approved", new Set(["consumed", "expired"])],
  ["denied", new Set()],
  ["expired", new Set()],
  ["consumed", new Set()],
]);

export function canTransitionDeviceAuth(
  from: DeviceAuthorizationState,
  to: DeviceAuthorizationState,
): boolean {
  return ALLOWED.get(from)?.has(to) ?? false;
}

function assertNotExpired(session: DeviceAuthorizationSession, now: Date): void {
  if (session.state === "expired") {
    throw new DomainError("EXPIRED", "Device authorization already expired", {
      id: session.id,
    });
  }
  if (now >= session.expiresAt && !TERMINAL.has(session.state)) {
    throw new DomainError("EXPIRED", "Device authorization expired", {
      id: session.id,
    });
  }
}

function apply(
  session: DeviceAuthorizationSession,
  to: DeviceAuthorizationState,
  patch: Partial<DeviceAuthorizationSession>,
): DeviceAuthorizationSession {
  if (!canTransitionDeviceAuth(session.state, to)) {
    throw invalidTransition(session.state, to, "device_authorization");
  }
  return {
    ...session,
    ...patch,
    state: to,
    id: session.id,
    deviceCodeDigest: session.deviceCodeDigest,
    userCodeDigest: session.userCodeDigest,
  };
}

export function approveDeviceAuth(
  session: DeviceAuthorizationSession,
  approvedByPrincipalId: string,
  now: Date = new Date(),
): DeviceAuthorizationSession {
  assertNotExpired(session, now);
  return apply(session, "approved", {
    approvedByPrincipalId,
    approvedAt: now,
  });
}

export function denyDeviceAuth(
  session: DeviceAuthorizationSession,
  now: Date = new Date(),
): DeviceAuthorizationSession {
  assertNotExpired(session, now);
  return apply(session, "denied", {});
}

export function consumeDeviceAuth(
  session: DeviceAuthorizationSession,
  now: Date = new Date(),
): DeviceAuthorizationSession {
  assertNotExpired(session, now);
  return apply(session, "consumed", { consumedAt: now });
}

export function expireDeviceAuth(
  session: DeviceAuthorizationSession,
  now: Date = new Date(),
): DeviceAuthorizationSession {
  if (TERMINAL.has(session.state) && session.state !== "expired") {
    throw invalidTransition(session.state, "expired", "device_authorization");
  }
  if (session.state === "expired") {
    throw invalidTransition(session.state, "expired", "device_authorization");
  }
  return apply(session, "expired", {});
}

export function maybeExpireDeviceAuth(
  session: DeviceAuthorizationSession,
  clock: Clock = () => new Date(),
): DeviceAuthorizationSession {
  const now = clock();
  if (TERMINAL.has(session.state)) {
    return session;
  }
  if (now >= session.expiresAt) {
    return expireDeviceAuth(session, now);
  }
  return session;
}

export function recordDevicePoll(
  session: DeviceAuthorizationSession,
  now: Date = new Date(),
): DeviceAuthorizationSession {
  return {
    ...session,
    pollCount: session.pollCount + 1,
    lastPolledAt: now,
  };
}
