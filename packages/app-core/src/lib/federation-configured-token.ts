import { randomString } from "@opensesame/sdk-browser";
import { originClientId } from "./federation-origin.js";
/** Configured identity connections require a signed assertion before becoming active. */
import type { PendingAuth } from "./federation-pending.js";
import type { UpstreamIdentity } from "./federation.js";
import { signInMethods } from "./settings.js";

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
/** A configured connection's audience and issuer are live trust, not remembered token metadata. */
export function configuredIdentitySessionTrusted(
  identity: Pick<UpstreamIdentity, "upstreamId" | "issuer" | "audience">,
): boolean {
  if (!identity.upstreamId.startsWith("identity:")) return true;
  const id = identity.upstreamId.slice("identity:".length);
  const provider = signInMethods().providers.find(
    (entry) => entry.connectionId === id,
  );
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
  identity: Pick<UpstreamIdentity, "upstreamId" | "issuer" | "audience">,
): void {
  if (!configuredIdentitySessionTrusted(identity))
    throw new Error(
      "Identity configuration changed during sign-in; start again",
    );
}
