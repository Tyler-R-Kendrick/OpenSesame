/**
 * Labels for the legacy kinds only. Every type's label — these included —
 * comes from its definition through `typeLabel()`; these tables remain as the
 * fallback for a screen holding a legacy kind and nothing else. Split from the
 * item model (`model.ts`), which re-exports them.
 */
export const KIND_LABEL = {
  account: "Account",
  credential: "Credential",
  passkey: "Passkey",
  card: "Card",
  secret: "Secret",
  note: "Secure note",
  certificate: "Certificate",
  drop: "Drop",
  typed: "Item",
};

export const KIND_PLURAL = {
  account: "Accounts",
  credential: "Credentials",
  passkey: "Passkeys",
  card: "Cards",
  secret: "Secrets",
  note: "Secure notes",
  certificate: "Certificates",
  drop: "Drops",
  typed: "Items",
};
