import { DomainError, invalidTransition } from "../errors.js";
import type { JsonObject } from "../json.js";
import type {
  AssuranceLevel,
  ClaimSession,
  ClaimState,
  Clock,
} from "../types.js";

const TERMINAL: ReadonlySet<ClaimState> = new Set([
  "completed",
  "denied",
  "revoked",
  "expired",
]);

const ALLOWED: ReadonlyMap<ClaimState, ReadonlySet<ClaimState>> = new Map([
  ["pending", new Set(["presented", "revoked", "expired"])],
  ["presented", new Set(["authenticated", "revoked", "expired"])],
  ["authenticated", new Set(["reviewed", "revoked", "expired"])],
  ["reviewed", new Set(["completed", "denied", "revoked", "expired"])],
  ["completed", new Set()],
  ["denied", new Set()],
  ["revoked", new Set()],
  ["expired", new Set()],
]);

export function canTransitionClaim(from: ClaimState, to: ClaimState): boolean {
  return ALLOWED.get(from)?.has(to) ?? false;
}

function assertNotExpired(session: ClaimSession, now: Date): void {
  if (session.state === "expired") {
    throw new DomainError("EXPIRED", "Claim already expired", {
      id: session.id,
    });
  }
  if (now >= session.expiresAt && !TERMINAL.has(session.state)) {
    throw new DomainError("EXPIRED", "Claim expired", {
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
    });
  }
}

function apply(
  session: ClaimSession,
  to: ClaimState,
  patch: Partial<ClaimSession>,
): ClaimSession {
  if (!canTransitionClaim(session.state, to)) {
    throw invalidTransition(session.state, to, "claim");
  }
  return {
    ...session,
    ...patch,
    state: to,
    // Immutable fields must not be overwritten by patch
    id: session.id,
    targetManifestDigest: session.targetManifestDigest,
    targetManifest: session.targetManifest,
    tokenDigest: session.tokenDigest,
    version: session.version + 1,
  };
}

export function presentClaim(
  session: ClaimSession,
  now: Date = new Date(),
): ClaimSession {
  assertNotExpired(session, now);
  return apply(session, "presented", { presentedAt: now });
}

export function authenticateClaim(
  session: ClaimSession,
  now: Date = new Date(),
): ClaimSession {
  assertNotExpired(session, now);
  return apply(session, "authenticated", { authenticatedAt: now });
}

export function reviewClaim(
  session: ClaimSession,
  decision: JsonObject,
  now: Date = new Date(),
): ClaimSession {
  assertNotExpired(session, now);
  return apply(session, "reviewed", {
    reviewedAt: now,
    reviewDecision: decision,
  });
}

export function completeClaim(
  session: ClaimSession,
  completedByPrincipalId: string,
  now: Date = new Date(),
): ClaimSession {
  assertNotExpired(session, now);
  if (session.state !== "reviewed") {
    throw invalidTransition(session.state, "completed", "claim");
  }
  return apply(session, "completed", {
    completedAt: now,
    completedByPrincipalId,
  });
}

export function denyClaim(
  session: ClaimSession,
  now: Date = new Date(),
): ClaimSession {
  assertNotExpired(session, now);
  return apply(session, "denied", { completedAt: now });
}

export function revokeClaim(
  session: ClaimSession,
  now: Date = new Date(),
): ClaimSession {
  if (TERMINAL.has(session.state) && session.state !== "revoked") {
    throw invalidTransition(session.state, "revoked", "claim");
  }
  if (session.state === "revoked") {
    throw invalidTransition(session.state, "revoked", "claim");
  }
  return apply(session, "revoked", { revokedAt: now });
}

export function expireClaim(
  session: ClaimSession,
  now: Date = new Date(),
): ClaimSession {
  if (TERMINAL.has(session.state) && session.state !== "expired") {
    throw invalidTransition(session.state, "expired", "claim");
  }
  if (session.state === "expired") {
    throw invalidTransition(session.state, "expired", "claim");
  }
  return apply(session, "expired", {});
}

/** Auto-expire if past TTL; otherwise return unchanged. */
export function maybeExpireClaim(
  session: ClaimSession,
  clock: Clock = () => new Date(),
): ClaimSession {
  const now = clock();
  if (TERMINAL.has(session.state)) {
    return session;
  }
  if (now >= session.expiresAt) {
    return expireClaim(session, now);
  }
  return session;
}

/**
 * Assurance may increase along allowed edges; never permanently label
 * phishing_resistant solely from presence of a passkey (session ACR/AMR).
 */
const ASSURANCE_ORDER: AssuranceLevel[] = [
  "provisional",
  "self_asserted",
  "verified",
  "mfa",
  "phishing_resistant",
  "enterprise_managed",
  "workload_attested",
];

export function canElevateAssurance(
  from: AssuranceLevel,
  to: AssuranceLevel,
): boolean {
  if (from === to) {
    return true;
  }
  // Allowed tree from brief:
  // provisional -> self_asserted | verified
  // verified -> mfa | phishing_resistant | enterprise_managed
  // workload_attested is orthogonal/special
  if (from === "provisional") {
    return to === "self_asserted" || to === "verified";
  }
  if (from === "self_asserted") {
    return to === "verified";
  }
  if (from === "verified") {
    return (
      to === "mfa" ||
      to === "phishing_resistant" ||
      to === "enterprise_managed" ||
      to === "workload_attested"
    );
  }
  if (from === "mfa") {
    return to === "phishing_resistant" || to === "enterprise_managed";
  }
  return ASSURANCE_ORDER.indexOf(to) > ASSURANCE_ORDER.indexOf(from);
}
