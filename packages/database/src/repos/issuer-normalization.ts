/**
 * Trailing-slash-normalized issuer, the form every issuer comparison uses.
 * `https://idp.example/` and `https://idp.example` are the same issuer, and a
 * store that disagreed would mint a second upstream for the second spelling.
 */
export function normalizeIssuer(issuer: string): string {
  const trimmed = issuer.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end -= 1;
  return trimmed.slice(0, end);
}
