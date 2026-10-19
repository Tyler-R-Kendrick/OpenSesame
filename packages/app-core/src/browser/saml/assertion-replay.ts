/** Volatile bounded replay custody supplements original-request InResponseTo and one-use POST delivery. */
import type { SamlProtocolClaims } from "./assertion.js";

const accepted = new Map<string, number>();
/** Claim synchronously after signature/protocol validation, before any admission await. */
export function claimNativeSamlAssertion(
  claims: SamlProtocolClaims,
  now: number,
): void {
  for (const [key, expiry] of accepted) if (expiry <= now) accepted.delete(key);
  const key = JSON.stringify([claims.issuer, claims.assertionId]);
  if (claims.validUntil <= now || accepted.has(key) || accepted.size >= 1024)
    throw new Error(
      "SAML assertion was already used or replay custody is full",
    );
  accepted.set(key, claims.validUntil);
}
