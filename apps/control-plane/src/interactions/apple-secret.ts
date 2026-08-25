import { SignJWT, importPKCS8 } from "jose";

/**
 * Apple's client secret is a signed assertion, not a string (D3, ADR 0055).
 *
 * "Sign in with Apple" has no long-lived client secret to configure. What an
 * operator registers is a P-256 signing key (`.p8`), a key id and a team id;
 * the value presented in the `client_secret` form field of the token request
 * is an ES256 JWT minted on the spot:
 *
 *   iss = the Apple developer team id
 *   sub = the Services ID (our client id at Apple)
 *   aud = https://appleid.apple.com   (fixed by Apple)
 *   kid = the private key's id, in the JOSE header
 *
 * Apple caps the lifetime at six months; this mints far shorter ones — the
 * assertion travels to exactly one endpoint over TLS and is trivially
 * re-mintable, so a long-lived one buys nothing and loses a bounded blast
 * radius. Minting is cached per (team, key, client) because a token exchange
 * is on the interactive path and an ECDSA signature per sign-in is waste, not
 * because signing is expensive enough to matter for security.
 *
 * The key material never leaves this module: the minted JWT is what callers
 * get, and it is the only thing that reaches `client.ClientSecretPost`.
 */

/** Apple's fixed audience for the client-secret assertion. */
export const APPLE_CLIENT_SECRET_AUDIENCE = "https://appleid.apple.com";

/** How long a minted assertion is valid. Short by choice — see above. */
const APPLE_SECRET_TTL_SECONDS = 600;
/**
 * Re-mint this far before expiry so an assertion cannot go stale between the
 * cache read and Apple's clock.
 */
const APPLE_SECRET_REFRESH_SKEW_SECONDS = 60;

/** The registered signing material for one Apple Services ID. */
export type AppleSigningKey = {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
};

type CachedSecret = { token: string; expiresAtMs: number };

const secretCache = new Map<string, CachedSecret>();

/** Exposed for tests; minted assertions are cached per process. */
export function resetAppleClientSecretCache(): void {
  secretCache.clear();
}

function cacheKey(key: AppleSigningKey, clientId: string): string {
  // The key id is an identifier, not secret material; the PEM never appears.
  return `${key.teamId}|${key.keyId}|${clientId}`;
}

/**
 * Mint (or reuse) the ES256 client-secret assertion for an Apple client.
 *
 * Throws when the configured key cannot be parsed as a PKCS#8 EC key — a
 * misconfigured provider must fail the sign-in loudly rather than fall back to
 * a secret-less request Apple would reject with a shrug.
 */
export async function mintAppleClientSecret(
  key: AppleSigningKey,
  clientId: string,
  now: Date = new Date(),
): Promise<string> {
  const nowMs = now.getTime();
  const cached = secretCache.get(cacheKey(key, clientId));
  if (cached && cached.expiresAtMs - APPLE_SECRET_REFRESH_SKEW_SECONDS * 1000 > nowMs) {
    return cached.token;
  }

  const privateKey = await importPKCS8(key.privateKeyPem, "ES256");
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + APPLE_SECRET_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: key.keyId })
    .setIssuer(key.teamId)
    .setSubject(clientId)
    .setAudience(APPLE_CLIENT_SECRET_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(privateKey);

  secretCache.set(cacheKey(key, clientId), {
    token,
    expiresAtMs: expiresAt * 1000,
  });
  return token;
}
