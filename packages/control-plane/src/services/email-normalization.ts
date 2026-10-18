/**
 * Addresses are compared and stored lowercased with surrounding space removed.
 * Nothing more: local-part normalization (dots, `+tags`) differs per provider,
 * and guessing wrong would either merge two people or split one.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
