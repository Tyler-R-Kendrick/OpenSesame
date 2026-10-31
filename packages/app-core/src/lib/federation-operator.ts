import type { TrustedUpstream } from "./federation.js";
import { type OperatorIdp, signInMethods } from "./settings.js";

/**
 * One operator-configured provider, as an upstream this app runs the code flow
 * against directly (ADR 0078).
 *
 * This is the road that makes an external IdP *be* the identity service. It
 * needs no OpenSesame identity service behind it: the browser is a public
 * OAuth client, PKCE binds the exchange, and the provider's own discovery
 * document supplies every endpoint. Its `clientId` is whatever the operator
 * registered for this origin at their provider — configuration, never a
 * credential, and useless without the redirect URI it is bound to.
 */
export function operatorUpstream(idp: OperatorIdp): TrustedUpstream {
  if (idp.protocol === "saml" || idp.nativeIdentity === true)
    throw new Error(
      "Use the saved native identity connection for this identity",
    );
  const upstream: TrustedUpstream = {
    id: idp.connectionId
      ? `identity:${idp.connectionId}`
      : `operator:${idp.issuer}`,
    displayName: idp.label,
    issuer: idp.issuer,
    accountKind: idp.label,
    clientId: idp.clientId,
  };
  if (idp.scope) upstream.scope = idp.scope;
  if (idp.providerHint) upstream.providerHint = idp.providerHint;
  return upstream;
}

/**
 * An operator's own provider is a trusted issuer for this deployment.
 *
 * `TRUSTED_UPSTREAMS` is compiled in because a *runtime-discovered* issuer
 * must never become trusted by completing a flow (ADR 0033 §2). This is the
 * other case: an issuer the operator durably configured, which is the same
 * trust relationship the configured Identity API already has in
 * `isBrokeredIssuer` — somebody with the deployment's settings said "this one
 * speaks for my users". It admits exactly the stored issuers, never whatever a
 * response happens to claim.
 */
export function isOperatorIdpIssuer(issuer: string): boolean {
  const wanted = issuer.replace(/\/+$/, "");
  return signInMethods().providers.some(
    (idp) =>
      idp.protocol !== "saml" &&
      idp.nativeIdentity !== true &&
      idp.issuer.replace(/\/+$/, "") === wanted,
  );
}
