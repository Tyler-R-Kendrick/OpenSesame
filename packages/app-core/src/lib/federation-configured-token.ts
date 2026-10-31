import { randomString } from "@opensesame/sdk-browser";
import { isNativeFederationFormat } from "./federation-native-session.js";
import { originClientId } from "./federation-origin.js";
/** Configured identity connections require a signed assertion before becoming active. */
import type { PendingAuth } from "./federation-pending.js";
import type { UpstreamIdentity } from "./federation.js";
import { type OperatorIdp, signInMethods } from "./settings.js";

export async function verifyConfiguredIdentityToken(
  token: string,
  pending: PendingAuth,
  jwksUri: string,
): Promise<void> {
  if (!pending.upstreamId.startsWith("identity:")) return;
  if (!pending.nonce)
    throw new Error("This identity sign-in has no nonce; start again");
  if (
    !configuredIdentitySessionTrusted({
      upstreamId: pending.upstreamId,
      issuer: pending.issuer,
      audience: pending.clientId ?? originClientId(),
    })
  )
    throw new Error(
      "Identity configuration changed during sign-in; start again",
    );
  const { verifyBrowserIdTokenClaims } = await import(
    "@opensesame/sdk-browser"
  );
  await verifyBrowserIdTokenClaims({
    nonce: pending.nonce,
    token,
    issuer: pending.issuer,
    clientId: pending.clientId ?? originClientId(),
    jwksUri,
    fetchImpl: fetch,
  });
}

export function configuredIdentityNonce(
  upstreamId: string,
): string | undefined {
  return upstreamId.startsWith("identity:") ? randomString(32) : undefined;
}
function matchesNativeTarget(
  identity: Pick<UpstreamIdentity, "issuer" | "audience" | "assertionFormat">,
  provider: OperatorIdp,
  format: "saml" | "native-oidc",
): boolean {
  return (
    identity.assertionFormat === format &&
    provider.issuer === identity.issuer &&
    provider.clientId === identity.audience
  );
}

/** A configured connection's audience and issuer are live trust, not remembered token metadata. */
export function configuredIdentitySessionTrusted(
  identity: Pick<
    UpstreamIdentity,
    "upstreamId" | "issuer" | "audience" | "assertionFormat"
  >,
): boolean {
  if (!identity.upstreamId.startsWith("identity:"))
    return !isNativeFederationFormat(identity.assertionFormat);
  const id = identity.upstreamId.slice("identity:".length);
  const provider = signInMethods().providers.find(
    (entry) => entry.connectionId === id,
  );
  if (provider?.protocol === "saml")
    return matchesNativeTarget(identity, provider, "saml");
  if (provider?.nativeIdentity === true)
    return (
      provider.protocol === "oidc" &&
      matchesNativeTarget(identity, provider, "native-oidc")
    );
  if (isNativeFederationFormat(identity.assertionFormat)) return false;
  return Boolean(
    provider &&
      provider.issuer.replace(/\/+$/, "") ===
        identity.issuer.replace(/\/+$/, "") &&
      provider.clientId === identity.audience,
  );
}

export function applyConfiguredIdentityNonce(
  url: URL,
  nonce: string | undefined,
): void {
  if (nonce) url.searchParams.set("nonce", nonce);
}

export function assertConfiguredIdentitySessionTrusted(
  identity: Pick<
    UpstreamIdentity,
    "upstreamId" | "issuer" | "audience" | "assertionFormat"
  >,
): void {
  if (!configuredIdentitySessionTrusted(identity))
    throw new Error(
      "Identity configuration changed during sign-in; start again",
    );
}

/** Native SAML has no persisted token-restoration path, even if mutable JSON omits its format. */
export function configuredSamlIdentity(upstreamId: string): boolean {
  if (!upstreamId.startsWith("identity:")) return false;
  const id = upstreamId.slice("identity:".length);
  return signInMethods().providers.some(
    (entry) => entry.connectionId === id && entry.protocol === "saml",
  );
}

/** Native-marked adapters never restore from a persisted scalar bearer. */
export function configuredNativeIdentity(upstreamId: string): boolean {
  if (configuredSamlIdentity(upstreamId)) return true;
  if (!upstreamId.startsWith("identity:")) return false;
  return signInMethods().providers.some(
    (entry) =>
      entry.connectionId === upstreamId.slice("identity:".length) &&
      entry.protocol === "oidc" &&
      entry.nativeIdentity === true,
  );
}
