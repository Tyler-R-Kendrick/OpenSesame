import { DomainError, invalidTransition } from "../errors.js";
import type {
  AgentRegistration,
  AgentRegistrationStatus,
  PrincipalId,
} from "../types.js";

/** No further transitions. Claimed is settled but still revocable. */
const TERMINAL: ReadonlySet<AgentRegistrationStatus> = new Set([
  "expired",
  "revoked",
]);

const ALLOWED: ReadonlyMap<
  AgentRegistrationStatus,
  ReadonlySet<AgentRegistrationStatus>
> = new Map([
  ["unclaimed", new Set(["claim_pending", "expired", "revoked"])],
  [
    "claim_pending",
    new Set(["claimed", "claim_pending", "expired", "revoked"]),
  ],
  ["claimed", new Set(["revoked"])],
  ["expired", new Set()],
  ["revoked", new Set()],
]);

export function canTransitionAgentRegistration(
  from: AgentRegistrationStatus,
  to: AgentRegistrationStatus,
): boolean {
  return ALLOWED.get(from)?.has(to) ?? false;
}

export function isTerminalAgentRegistration(
  status: AgentRegistrationStatus,
): boolean {
  return TERMINAL.has(status);
}

function assertLive(registration: AgentRegistration, now: Date): void {
  if (registration.status === "expired") {
    throw new DomainError("EXPIRED", "Agent registration already expired", {
      id: registration.id,
    });
  }
  if (registration.status === "revoked") {
    throw new DomainError("EXPIRED", "Agent registration revoked", {
      id: registration.id,
    });
  }
  // Claimed survives TTL so a human can still revoke it after the pre-claim
  // window. Unclaimed / claim_pending expire with the registration.
  if (registration.status === "claimed") return;
  if (now >= registration.expiresAt) {
    throw new DomainError("EXPIRED", "Agent registration expired", {
      id: registration.id,
      expiresAt: registration.expiresAt.toISOString(),
    });
  }
}

function apply(
  registration: AgentRegistration,
  to: AgentRegistrationStatus,
  patch: Partial<AgentRegistration>,
): AgentRegistration {
  if (!canTransitionAgentRegistration(registration.status, to)) {
    throw invalidTransition(registration.status, to, "agent_registration");
  }
  return {
    ...registration,
    ...patch,
    status: to,
    id: registration.id,
    kind: registration.kind,
    createdAt: registration.createdAt,
    version: registration.version + 1,
  };
}

export function markAgentRegistrationExpired(
  registration: AgentRegistration,
  now: Date = new Date(),
): AgentRegistration {
  if (registration.status === "expired") return registration;
  if (registration.status === "claimed" || registration.status === "revoked") {
    throw invalidTransition(
      registration.status,
      "expired",
      "agent_registration",
    );
  }
  if (now < registration.expiresAt) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Cannot expire a registration before its TTL",
      { id: registration.id },
    );
  }
  return apply(registration, "expired", {});
}

export function markAgentRegistrationClaimPending(
  registration: AgentRegistration,
  now: Date = new Date(),
): AgentRegistration {
  assertLive(registration, now);
  if (registration.status === "claim_pending") {
    return { ...registration, version: registration.version + 1 };
  }
  return apply(registration, "claim_pending", {});
}

export function claimAgentRegistration(
  registration: AgentRegistration,
  claimedByPrincipalId: PrincipalId,
  now: Date = new Date(),
): AgentRegistration {
  assertLive(registration, now);
  if (!claimedByPrincipalId) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Claim requires an authenticated principal",
      { id: registration.id },
    );
  }
  return apply(registration, "claimed", {
    claimedByPrincipalId,
    principalId: claimedByPrincipalId,
    claimedAt: now,
    assertionVersion: registration.assertionVersion + 1,
  });
}

export function revokeAgentRegistration(
  registration: AgentRegistration,
  now: Date = new Date(),
): AgentRegistration {
  if (registration.status === "revoked") return registration;
  if (registration.status === "expired") {
    throw invalidTransition(
      registration.status,
      "revoked",
      "agent_registration",
    );
  }
  return apply(registration, "revoked", { revokedAt: now });
}

/**
 * Ownership model (ADR 0092): claiming never merges principals and never
 * copies resources. The registration's principalId becomes the authenticated
 * principal. Pre-claim resources stay on the original provisional principal.
 */
export function claimedPrincipalId(
  registration: AgentRegistration,
): PrincipalId {
  return registration.claimedByPrincipalId ?? registration.principalId;
}
