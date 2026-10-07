/** Private provenance for captured connector operations and cache descendants. */
import {
  assertNotDecoySession,
  currentRealmGeneration,
  isRealAuthorityBlocked,
} from "./decoy-session.js";
type FeatureAuthorityValue = Readonly<{ providerId: string }>;
const realms = new WeakMap<FeatureAuthorityValue, number>();
export function bindFeatureAuthority<T extends FeatureAuthorityValue>(
  value: T,
): T {
  const realm = assertNotDecoySession();
  const previous = realms.get(value);
  if (previous !== undefined) assertNotDecoySession(previous);
  realms.set(value, realm);
  return value;
}
export function featureAuthorityCurrent(value: FeatureAuthorityValue): boolean {
  return (
    !isRealAuthorityBlocked() && realms.get(value) === currentRealmGeneration()
  );
}
export function assertFeatureAuthority(value: FeatureAuthorityValue): void {
  bindFeatureAuthority(value);
}
