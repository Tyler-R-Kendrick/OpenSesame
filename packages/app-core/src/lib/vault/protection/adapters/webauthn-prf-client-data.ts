/**
 * What a WebAuthn ceremony's clientDataJSON must say before its answer is
 * trusted — type, origin, RP id — and the id encodings the ceremony compares.
 * Pure: no ceremony I/O (split from webauthn-prf-ceremony.ts, ADR 0093).
 */

import { isString, overlapCast } from "@opensesame/os-domain";
import { bytesToB64 } from "@opensesame/vault-core";
import { maybePage } from "../../../../ports.js";
import { PrfCeremonyError } from "./webauthn-prf-output.js";

export type CeremonyClientDataAssert = {
  rpId: string;
  expectCreate: boolean;
};

type CeremonyClientData = {
  type?: string;
  origin?: string;
  rpId?: string;
};

function readCeremonyClientData(
  credential: PublicKeyCredential,
): CeremonyClientData | null {
  const response = credential.response;
  if (response === undefined || response === null) return null;
  if (!("clientDataJSON" in response)) return null;
  try {
    const parsed = overlapCast(
      JSON.parse(new TextDecoder().decode(response.clientDataJSON)),
    );
    const data: CeremonyClientData = {};
    if (isString(parsed.type)) data.type = parsed.type;
    if (isString(parsed.origin)) data.origin = parsed.origin;
    if (isString(parsed.rpId)) data.rpId = parsed.rpId;
    return data;
  } catch {
    return null;
  }
}

function expectedWebauthnOrigin(): string {
  return maybePage()?.location.origin ?? "http://localhost";
}

export function assertCeremonyClientData(
  credential: PublicKeyCredential,
  options: CeremonyClientDataAssert,
): void {
  const data = readCeremonyClientData(credential);
  if (!data) return;
  const expectedType = options.expectCreate
    ? "webauthn.create"
    : "webauthn.get";
  if (data.type && data.type !== expectedType) {
    throw new PrfCeremonyError(
      "wrong_rp",
      `Passkey ceremony type was ${data.type}, expected ${expectedType}.`,
    );
  }
  const expectedOrigin = expectedWebauthnOrigin();
  if (data.origin && data.origin !== expectedOrigin) {
    throw new PrfCeremonyError(
      "origin_mismatch",
      `Passkey origin was ${data.origin}, expected ${expectedOrigin}.`,
    );
  }
  if (data.rpId && data.rpId !== options.rpId) {
    throw new PrfCeremonyError(
      "wrong_rp",
      `Passkey RP id was ${data.rpId}, expected ${options.rpId}.`,
    );
  }
}

export function credentialIdMatches(
  credential: PublicKeyCredential,
  credentialIdB64: string,
): boolean {
  return bytesToB64(new Uint8Array(credential.rawId)) === credentialIdB64;
}

/** Convert our standard btoa id into the base64url form WebAuthn maps use. */
export function toWebauthnBase64Url(standardB64: string): string {
  return standardB64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
