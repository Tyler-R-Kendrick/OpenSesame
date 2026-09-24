/**
 * Providers that can issue a temporary card (catalog category `wallet`).
 * A payment method of that kind is offered only when one of these is connected.
 */

export const WALLET_ISSUER_IDS = [
  "privacy",
  "lithic",
  "marqeta",
  "stripe-issuing",
] as const;

export type WalletIssuerId = (typeof WALLET_ISSUER_IDS)[number];

export function isWalletIssuer(providerId: string): boolean {
  // SAFETY: WALLET_ISSUER_IDS is the checked-in issuer id tuple; includes() needs readonly string[].
  return (WALLET_ISSUER_IDS as readonly string[]).includes(providerId);
}

export function connectedWalletIssuerIds(
  connections: readonly { providerId: string; status: string }[],
): readonly WalletIssuerId[] {
  const seen = new Set<WalletIssuerId>();
  for (const connection of connections) {
    if (connection.status !== "active") continue;
    if (!isWalletIssuer(connection.providerId)) continue;
    // SAFETY: isWalletIssuer checked providerId against WALLET_ISSUER_IDS (WalletIssuerId source).
    seen.add(connection.providerId as WalletIssuerId);
  }
  return WALLET_ISSUER_IDS.filter((id) => seen.has(id));
}

export function temporaryCardsAvailable(
  connections: readonly { providerId: string; status: string }[],
): boolean {
  return connectedWalletIssuerIds(connections).length > 0;
}
