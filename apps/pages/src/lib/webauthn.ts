/** How much WebAuthn this browser can actually finish. */

export type WebAuthnSupport = "ok" | "partial" | "missing";

export async function detectWebAuthn(
  cred: Pick<
    typeof PublicKeyCredential,
    "isUserVerifyingPlatformAuthenticatorAvailable"
  > | null = typeof PublicKeyCredential === "undefined"
    ? null
    : PublicKeyCredential,
): Promise<WebAuthnSupport> {
  if (!cred) return "missing";
  try {
    const platform =
      await cred.isUserVerifyingPlatformAuthenticatorAvailable?.();
    return platform ? "ok" : "partial";
  } catch {
    return "partial";
  }
}

export const WEBAUTHN_FALLBACK =
  "This browser is not your phone or YubiKey. If a site asks for a passkey, use TOTP, email, or approve on your phone instead of waiting on a prompt that cannot finish here.";
