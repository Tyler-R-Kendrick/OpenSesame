/**
 * Intersect IAM role grants with incident deny ceilings (AUTH-B).
 * Never elevates — only narrows.
 */
export function narrowCapabilities(
  granted: readonly string[],
  denyOperations: readonly string[],
  ceiling: readonly string[],
): string[] {
  const deny = new Set(denyOperations);
  let next = granted.filter((g) => !deny.has(g));
  if (ceiling.length > 0) {
    const allow = new Set(ceiling);
    next = next.filter((g) => allow.has(g));
  }
  return next;
}
