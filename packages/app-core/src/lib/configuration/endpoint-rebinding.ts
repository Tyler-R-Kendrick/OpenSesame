/**
 * When identityApi or hostApi changes, previously cached Authorization
 * headers must not follow the new origin (ADV-13).
 */
export function authorizationForDestination(
  stored: { destination: string; authorization: string } | null,
  nextDestination: string,
): string | null {
  if (!stored) return null;
  if (stored.destination !== nextDestination) return null;
  return stored.authorization;
}
