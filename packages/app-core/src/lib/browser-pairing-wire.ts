/**
 * What a browser pairing reads off the wire, checked (ADR 0048 §8, ADR 0136).
 *
 * Pure: the pairing's state lives in `browser-pairing.ts`; this module only
 * decides whether what an endpoint answered is a prompt, a grant, or a path
 * this page may send its proof to.
 */
import { isNumber, isString } from "@opensesame/os-domain";
import type { readBoundedObject } from "./bounded-response.js";

type Wire = Awaited<ReturnType<typeof readBoundedObject>>;

export class BrowserPairingError extends Error {
  constructor(
    readonly code:
      | "restricted_demo"
      | "pairing_required"
      | "pairing_failed"
      | "pairing_expired",
  ) {
    super(
      code === "restricted_demo"
        ? "This shared-origin demo cannot connect to local authority. Use a dedicated or loopback deployment."
        : code === "pairing_required"
          ? "This browser has no approved grant for that action."
          : code,
    );
    this.name = "BrowserPairingError";
  }
}

export type PairingPrompt = {
  pairingId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
};
export function validatedPrompt(value: Wire, hostApi: string) {
  if (
    !isString(value.pairing_id) ||
    !isString(value.device_code) ||
    value.device_code.length < 32 ||
    !isString(value.user_code) ||
    !/^[A-Z0-9-]{6,32}$/.test(value.user_code) ||
    !isString(value.verification_uri) ||
    !isNumber(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 300 ||
    !isNumber(value.interval) ||
    value.interval < 1 ||
    value.interval > 30
  )
    throw new BrowserPairingError("pairing_failed");
  const verification = verificationUrl(value.verification_uri, hostApi);
  const prompt: PairingPrompt = {
    pairingId: value.pairing_id,
    userCode: value.user_code,
    verificationUri: verification.href,
    expiresAt: Date.now() + value.expires_in * 1000,
    interval: value.interval,
  };
  return { prompt, deviceCode: value.device_code };
}

export function validatedToken(value: Wire, asked: readonly string[]) {
  if (
    value.token_type !== "DPoP" ||
    !isString(value.access_token) ||
    value.access_token.length < 32 ||
    value.access_token.length > 4096 ||
    !isString(value.client_id) ||
    !value.client_id ||
    value.client_id.length > 128 ||
    !isNumber(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 300 ||
    !isString(value.scope)
  )
    throw new BrowserPairingError("pairing_failed");
  const capabilities = value.scope.split(" ");
  // The grant may be narrower than what was asked, never wider or other.
  if (
    !capabilities.length ||
    capabilities.some((capability) => !asked.includes(capability))
  )
    throw new BrowserPairingError("pairing_failed");
  return {
    accessToken: value.access_token,
    clientId: value.client_id,
    expiresAt: Date.now() + value.expires_in * 1000,
    capabilities,
  };
}

export function pairedUrl(hostApi: string, path: string) {
  if (!path.startsWith("/api/v1/") || path.includes("\\") || path.includes("#"))
    throw new BrowserPairingError("pairing_failed");
  const url = `${hostApi}${path}`;
  if (new URL(url).pathname !== path.split("?")[0] || /%2e|%2f|%5c/i.test(path))
    throw new BrowserPairingError("pairing_failed");
  return url;
}

function verificationUrl(raw: string, hostApi: string) {
  const verification = new URL(raw);
  if (
    verification.origin !== new URL(hostApi).origin ||
    verification.search ||
    verification.hash ||
    verification.username ||
    verification.password
  )
    throw new BrowserPairingError("pairing_failed");
  return verification;
}
