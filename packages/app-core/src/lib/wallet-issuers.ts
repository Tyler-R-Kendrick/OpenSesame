/**
 * Providers that can issue a temporary card (catalog category `wallet`).
 * A payment method of that kind is offered only when one of these is connected.
 */

import type { Provider } from "./connections.js";

export const WALLET_ISSUER_IDS = [
  "privacy",
  "lithic",
  "marqeta",
  "stripe-issuing",
] as const;

export const WALLET_HOST = [
  ["privacy", "https://privacy.com/developer/docs", "api.privacy.com"],
  ["lithic", "https://docs.lithic.com/docs/authentication", "api.lithic.com"],
  [
    "marqeta",
    "https://www.marqeta.com/docs/developer-guides/api-authentication",
    "api.marqeta.com",
  ],
  ["stripe-issuing", "https://docs.stripe.com/issuing", "api.stripe.com"],
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

export function walletHostProviders(
  preview: (id: string, docs: string, auth: "api_key") => Provider,
): Provider[] {
  return WALLET_HOST.map(([id, docs, host]) => {
    const provider = preview(id, docs, "api_key");
    provider.category = "wallet";
    provider.operations = [];
    provider.egress = {
      scheme: "https",
      authorities: [host],
      pathPrefixes: [],
    };
    return provider;
  });
}
