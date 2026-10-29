import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object(value) === value)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function reviewedResultDigest(result) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(result)))
    .digest("hex");
}

// Tailscale's SetConfigExpectedCert callback verifies both the certificate and
// hostname. Every field of this exact upstream SARIF result was reviewed.
export const REVIEWED_NATIVE_RESULTS = new Map([
  [
    "a60856cea2ba72dad70d5934af72e142890749787de2d8f13bf0d8d6844bae7d",
    "Tailscale custom certificate and hostname verification",
  ],
]);
