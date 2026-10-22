import { bestItemFormat, parseItemFormat } from "@opensesame/vault-core";

/** Names the recognised issuer shape; it never renders the value itself. */
export function FormatHint({
  typeId,
  value,
}: {
  /** The item type whose field is being edited, when there is one. */
  typeId?: string;
  value: string;
}) {
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
