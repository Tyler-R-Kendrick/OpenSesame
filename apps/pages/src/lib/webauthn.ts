/** How much WebAuthn this browser can actually finish. */

export type WebAuthnSupport = "ok" | "partial" | "missing";

async function detectWebAuthnDefault(
  cred: Pick<
    typeof PublicKeyCredential,
    "isUserVerifyingPlatformAuthenticatorAvailable"
  > | null = globalThis.PublicKeyCredential === undefined
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

const WEBAUTHN_FALLBACK_DEFAULT =
  "This browser is not your phone or YubiKey. If a site asks for a passkey, use TOTP, email, or approve on your phone instead of waiting on a prompt that cannot finish here.";

export const webauthnSeams = {
  detectWebAuthn: detectWebAuthnDefault,
  WEBAUTHN_FALLBACK: WEBAUTHN_FALLBACK_DEFAULT,
};

export async function detectWebAuthn(
  cred?: Parameters<typeof detectWebAuthnDefault>[0],
): Promise<WebAuthnSupport> {
  return cred === undefined
    ? webauthnSeams.detectWebAuthn()
    : webauthnSeams.detectWebAuthn(cred);
}

export const WEBAUTHN_FALLBACK = WEBAUTHN_FALLBACK_DEFAULT;
