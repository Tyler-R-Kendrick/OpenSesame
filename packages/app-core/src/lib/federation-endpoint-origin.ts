/** True when `endpoint` is a URL on the same origin as `issuer`. */
export function endpointBelongsToIssuer(
  endpoint: string,
  issuer: string,
): boolean {
  try {
    return new URL(endpoint).origin === new URL(issuer).origin;
  } catch {
    return false;
  }
}
