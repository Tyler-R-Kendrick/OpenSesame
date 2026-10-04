/** Item kind labels: the legacy kinds only, split from the item model. */
import type { ItemKind } from "./model.js";

/**
 * Labels for the legacy kinds only. Every type's label — these included —
 * comes from its definition through `typeLabel()`; these tables remain as the
 * fallback for a screen holding a legacy kind and nothing else.
 */
export const KIND_LABEL: Readonly<Record<ItemKind, string>> = {
  login: "Login",
  passkey: "Passkey",
  card: "Card",
  secret: "Secret",
  note: "Secure note",
  certificate: "Certificate",
  drop: "Drop",
  typed: "Item",
};

export const KIND_PLURAL: Readonly<Record<ItemKind, string>> = {
  login: "Logins",
  passkey: "Passkeys",
  card: "Cards",
  secret: "Secrets",
  note: "Secure notes",
  certificate: "Certificates",
  drop: "Drops",
  typed: "Items",
};
