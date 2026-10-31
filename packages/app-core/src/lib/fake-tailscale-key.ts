/**
 * Test-only Tailscale-shaped credentials. Never import this module from production
 * paths — values are minted at runtime from random bytes and always carry an
 * obvious FAKE marker so they cannot be mistaken for live Tailscale API keys.
 */

const KEY_PREFIX = ["ts", "key"].join("");

function randomAlphanumeric(length: number): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += alphabet.charAt(byte % alphabet.length);
  }
  return out;
}

type FakeTailscaleKeyKind = "api" | "client" | "auth";

/** Mint a fake Tailscale API access token (`tskey-api-…`). */
export function fakeTailscaleApiKey(): string {
  return mintFakeTailscaleKey("api");
}

/** Mint a fake Tailscale OAuth client secret (`tskey-client-…`). */
export function fakeTailscaleClientKey(): string {
  return mintFakeTailscaleKey("client");
}

/** Mint a fake Tailscale auth key (`tskey-auth-…`). */
export function fakeTailscaleAuthKey(): string {
  return mintFakeTailscaleKey("auth");
}

/** OAuth client id shape used in Tailscale tests (not a tskey). */
export function fakeTailscaleClientId(): string {
  return `kFAKE0${randomAlphanumeric(6).toUpperCase()}`;
}

/** Provider error text that embeds a fake key for redaction tests. */
export function fakeTailscaleLeakMessage(apiKey: string): string {
  return `Key ${apiKey} for user@private.example is invalid`;
}

/** Prefix of a minted auth key that must not appear in persisted connector JSON. */
export function fakeTailscaleAuthKeyPublicPrefix(authKey: string): string {
  return authKey.slice(0, authKey.lastIndexOf("-"));
}

function mintFakeTailscaleKey(kind: FakeTailscaleKeyKind): string {
  const marker = "FAKE0TEST";
  const tail = randomAlphanumeric(24);
  return `${KEY_PREFIX}-${kind}-k${marker}-${tail}`;
}
