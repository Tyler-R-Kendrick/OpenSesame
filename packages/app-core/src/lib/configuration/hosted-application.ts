/** ADV-32: a draft bound to one issuer cannot auto-apply to another. */
export function hostedDraftMatchesIssuer(
  boundIssuer: string,
  currentIssuer: string,
): boolean {
  return boundIssuer === currentIssuer && boundIssuer.length > 0;
}
