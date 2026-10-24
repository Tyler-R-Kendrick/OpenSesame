import { bestItemFormat, parseItemFormat } from "@opensesame/vault-core";

import type { FormatHintProps } from "./FormatHint.js";

/** Names the recognised issuer shape; it never renders the value itself. */
export function FormatHintMatch({ typeId, value }: FormatHintProps) {
  if (value.trim() === "") return null;
  const exact = typeId ? parseItemFormat(typeId, value) : null;
  const exactUseful =
    exact !== null &&
    exact.formatId !== "password" &&
    exact.formatId !== "opaque-secret";
  // A password is allowed to look like anything; never classify its value.
  const match =
    exactUseful || typeId === "password" ? exact : bestItemFormat(value);
  // A generic fallback is useful for a secret; it is noise for a password or
  // a field whose own type already answered above.
  return match && (exactUseful || match.specificity >= 50) ? (
    <span className="hint">Recognised format: {match.label}</span>
  ) : null;
}
