/**
 * Capability metadata only: safe for scheduling while parser and generator
 * implementations are not loaded. Registry parity tests require this set to
 * match the real implementations, including optional item types.
 */
const GENERATOR_TYPE_IDS: ReadonlySet<string> = new Set([
  "api-credential",
  "api-key",
  "authenticator",
  "backup-codes",
  "bank-account",
  "card",
  "crypto-wallet",
  "database",
  "email-account",
  "gift-card",
  "identity-document",
  "passkey",
  "passport",
  "password",
  "secret",
  "server",
  "software-license",
  "ssh-key",
  "token",
  "vehicle",
  "wifi",
]);

/** A synthetic format generator exists; this does not imply provider rotation. */
export function itemTypeHasFormatGenerator(typeId: string): boolean {
  return GENERATOR_TYPE_IDS.has(typeId);
}
