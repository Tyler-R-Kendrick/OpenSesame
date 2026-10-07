import {
  admitFreshOwnerAuthentication,
  currentRealmGeneration,
  freshOwnerAuthenticationTomb,
  freshOwnerAuthenticationVault,
  markDecoySession,
} from "../decoy-session.js";

/**
 * Reset isolated unit state through the trusted internal completion seam.
 * This does not demonstrate authentication. Lifecycle security tests must use
 * the actual password/factor path for their positive admission assertions.
 */
export function resetRealmFixture(): void {
  markDecoySession(false);
  // A marker-only fixture has null origin. Real store hooks always pass a
  // concrete tomb and cannot use that to release an unknown-origin latch.
  admitFreshOwnerAuthentication(
    freshOwnerAuthenticationTomb(),
    currentRealmGeneration(),
    freshOwnerAuthenticationVault(),
  );
}
