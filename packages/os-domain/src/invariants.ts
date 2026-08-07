import { DomainError } from "./errors.js";
import type {
  ClaimItem,
  ClaimSession,
  DeviceAuthorizationSession,
  Principal,
  PrincipalId,
} from "./types.js";

/**
 * Invariants:
 * - provisional is Principal state/assurance, not a separate Principal type
 * - claim ≠ device auth (distinct session types)
 * - principal ID is stable across assurance upgrades
 */

export function assertPrincipalIdStable(
  before: Principal,
  after: Principal,
): void {
  if (before.id !== after.id) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Principal ID must remain stable across upgrades",
      { before: before.id, after: after.id },
    );
  }
}

export function isProvisionalPrincipal(principal: Principal): boolean {
  return (
    principal.state === "provisional" || principal.assurance === "provisional"
  );
}

export function assertNotSameAsDeviceAuth(
  claim: ClaimSession,
  device: DeviceAuthorizationSession,
): void {
  // Structural separation: claim sessions never share identity with device sessions
  if (claim.id === device.id) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Claim session must not share id with device authorization session",
      { id: claim.id },
    );
  }
}

export function elevatePrincipalAssurance(
  principal: Principal,
  assurance: Principal["assurance"],
  state: Principal["state"] = principal.state === "provisional"
    ? "active"
    : principal.state,
  now: Date = new Date(),
): Principal {
  const next: Principal = {
    ...principal,
    assurance,
    state,
    updatedAt: now,
    version: principal.version + 1,
  };
  if (assurance !== "provisional" && !next.verifiedAt) {
    next.verifiedAt = now;
  }
  assertPrincipalIdStable(principal, next);
  return next;
}

/**
 * Partial claim dependency closure: accepting an item requires all
 * dependency item IDs to also be accepted (or included in the accept set).
 */
export function assertDependencyClosure(
  items: readonly ClaimItem[],
  acceptedIds: ReadonlySet<string>,
): void {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const id of acceptedIds) {
    const item = byId.get(id);
    if (!item) {
      throw new DomainError("NOT_FOUND", `Claim item not found: ${id}`, { id });
    }
    for (const dep of item.dependencies) {
      if (!acceptedIds.has(dep)) {
        throw new DomainError(
          "DEPENDENCY_CLOSURE",
          `Accepted item ${id} requires dependency ${dep}`,
          { itemId: id, missingDependency: dep },
        );
      }
    }
  }
  for (const item of items) {
    if (item.required && !acceptedIds.has(item.id)) {
      throw new DomainError(
        "DEPENDENCY_CLOSURE",
        `Required claim item not accepted: ${item.id}`,
        { itemId: item.id },
      );
    }
  }
}

export function assertManifestImmutable(
  original: ClaimSession,
  candidate: ClaimSession,
): void {
  if (original.targetManifestDigest !== candidate.targetManifestDigest) {
    throw new DomainError(
      "IMMUTABLE_FIELD",
      "targetManifestDigest is immutable",
      {
        original: original.targetManifestDigest,
        candidate: candidate.targetManifestDigest,
      },
    );
  }
}

export function newPrincipalId(prefix = "prn"): PrincipalId {
  const rand = cryptoRandomId();
  return `${prefix}_${rand}`;
}

function cryptoRandomId(): string {
  // Avoid importing node:crypto here for browser-safe optional use; Node has global crypto.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}
