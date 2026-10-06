import { isRealAuthorityBlocked } from "./decoy-session.js";
import type { IdentitySession, identitySeams } from "./identity.js";

type Readers = Pick<
  typeof identitySeams,
  "hostLocalSessionEligible" | "currentSession"
>;

export function readHostSessionEligibility(
  readers: Readers,
  hostApi?: string,
): boolean {
  if (isRealAuthorityBlocked()) return false;
  // Keep the seamed implementation's default argument lazy and preserve its receiver.
  return hostApi === undefined
    ? readers.hostLocalSessionEligible()
    : readers.hostLocalSessionEligible(hostApi);
}
export function readVisibleIdentitySession(
  readers: Readers,
): IdentitySession | null {
  if (isRealAuthorityBlocked()) return null;
  return readers.currentSession();
}
