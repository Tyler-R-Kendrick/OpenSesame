/** The small cryptographic surface the deadman switch uses (ADR 0209). */

import type { BoundaryValue } from "@opensesame/os-domain";
import { isJsonObject, asBufferSource } from "@opensesame/os-domain";
import { b64urlToBytes, bytesToB64url } from "@opensesame/sdk-browser";

const CURVE = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export type SigningPair = Readonly<{
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}>;

/** Stable JSON so a signature never depends on object property order. */
export function canonicalJson(value: BoundaryValue): string {
  const stable = (input: BoundaryValue): BoundaryValue => {
    if (Array.isArray(input)) return input.map(stable);
    if (isJsonObject(input)) {
      const out: Record<string, BoundaryValue> = {};
      for (const key of Object.keys(input).sort()) {
        const entry = input[key];
        if (entry !== undefined) out[key] = stable(entry);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(stable(value));
}

export async function generateSigningPair(): Promise<SigningPair> {
  const pair = await crypto.subtle.generateKey(CURVE, true, ["sign", "verify"]);
  const [publicKeyJwk, privateKeyJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  return { publicKeyJwk, privateKeyJwk };
}

export async function signText(
  privateKeyJwk: JsonWebKey,
  text: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    CURVE,
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    SIGN,
    key,
    new TextEncoder().encode(text),
  );
  return bytesToB64url(new Uint8Array(signature));
}

export async function verifyText(
  publicKeyJwk: JsonWebKey,
  text: string,
  signatureB64: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicKeyJwk,
      CURVE,
      false,
      ["verify"],
    );
    if (!/^[A-Za-z0-9_-]{86}$/.test(signatureB64)) return false;
    const signature = b64urlToBytes(signatureB64);
    if (signature.byteLength !== 64) return false;
    return await crypto.subtle.verify(
      SIGN,
      key,
      asBufferSource(signature),
      new TextEncoder().encode(text),
    );
  } catch {
    return false;
  }
}
