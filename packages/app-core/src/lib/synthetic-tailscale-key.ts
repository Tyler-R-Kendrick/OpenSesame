/**
 * Runtime-only Tailscale-shaped credentials for tests. Values are minted from
 * CSPRNG and satisfy the same format checks as production keys. Never persist
 * these strings in the repository.
 */

import { TOKEN as TOKEN_PATTERN } from "./native-tailscale-api.js";

const KEY_PREFIX = ["ts", "key"].join("");
const ALPHANUM =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomChars(length: number, alphabet = ALPHANUM): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) break;
    out += alphabet.charAt(byte % alphabet.length);
  }
  return out;
}

function randomTailscaleSegment(min: number, max: number): string {
  const span = max - min + 1;
  const length = min + (randomChars(1, "0123456789").charCodeAt(0)! % span);
  let rest = randomChars(length);
  rest = rest.replaceAll(/[^A-Za-z0-9]/g, "A");
  return rest;
}

type SyntheticTailscaleKeyKind = "api" | "client" | "auth";

function mintSyntheticTailscaleKey(kind: SyntheticTailscaleKeyKind): string {
  const rest = randomTailscaleSegment(8, 48);
  return `${KEY_PREFIX}-${kind}-${rest}`;
}

/** Mint a synthetic Tailscale API access token (`tskey-api-…`). */
export function syntheticTailscaleApiKey(): string {
  return mintSyntheticTailscaleKey("api");
}

/** Mint a synthetic Tailscale OAuth client secret (`tskey-client-…`). */
export function syntheticTailscaleClientKey(): string {
  return mintSyntheticTailscaleKey("client");
}

/** Control-plane auth-key id segment (`k…`, as Tailscale returns on mint). */
export function syntheticTailscaleAuthKeyControlId(): string {
  return `k${randomChars(11).toUpperCase()}`;
}

/** Full auth key for a given control id (`tskey-auth-{id}-…`). */
export function syntheticTailscaleAuthKeyForControlId(controlId: string): string {
  const tail = randomTailscaleSegment(12, 32);
  return `${KEY_PREFIX}-auth-${controlId}-${tail}`;
}

/** Mint a synthetic Tailscale auth key (`tskey-auth-…`). */
export function syntheticTailscaleAuthKey(): string {
  const controlId = syntheticTailscaleAuthKeyControlId();
  return syntheticTailscaleAuthKeyForControlId(controlId);
}

/** OAuth client id shape used in Tailscale tests (not a tskey). */
export function syntheticTailscaleClientId(): string {
  return randomChars(12);
}

/** Provider error text that embeds a key for redaction tests. */
export function syntheticTailscaleLeakMessage(apiKey: string): string {
  return `Key ${apiKey} for user@private.example is invalid`;
}

/** Prefix of a minted auth key that must not appear in persisted connector JSON. */
export function syntheticTailscaleAuthKeyPublicPrefix(authKey: string): string {
  return authKey.slice(0, authKey.lastIndexOf("-"));
}

/** Assert a minted value satisfies the production token regex (tests). */
export function assertSyntheticTailscaleToken(value: string): void {
  if (!TOKEN_PATTERN.test(value)) {
    throw new Error("Synthetic Tailscale key failed production format check");
  }
}
