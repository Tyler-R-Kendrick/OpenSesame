/** Seeded plaintext canaries, not short patterns that random ciphertext can contain. */
const FULL_CANARIES = [
  "user-alice",
  "user-bob",
  "user-carol",
  "2026-01-01T00:00:00Z",
  "2026-02-01T00:00:00Z",
  "2026-03-01T00:00:00Z",
  "Quarterly vault review for Alice",
  "Denied: unknown device",
  "Vault key rotation",
];
const JSON_NAMES_AND_VALUES = [
  "r1",
  "r2",
  "r3",
  "s1",
  "s2",
  "receipts",
  "sessions",
  "id",
  "userId",
  "action",
  "at",
  "amount",
  "note",
  "tags",
  "approve",
  "deny",
  "vault",
  "review",
  "history",
];
export function leakedSeedPlaintext(raw: string): string[] {
  const text = raw.toLowerCase();
  return [
    ...FULL_CANARIES,
    ...JSON_NAMES_AND_VALUES.map((value) => JSON.stringify(value)),
  ].filter((canary) => text.includes(canary.toLowerCase()));
}
