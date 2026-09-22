/**
 * Compartment-local AES-GCM seals (COMPARTMENT-UX).
 * Domain-separated from vault root seals — independent compartment keys only.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  overlapCast,
} from "../json-boundary.js";

const te = new TextEncoder();
const IV_BYTES = 12;
const PURPOSE = "opensesame/duress/compartment-seal/v1";

export type SealedCompartmentBlob = Readonly<{
  version: 1;
  compartmentRef: string;
  keyEpoch: number;
  ivB64: string;
  ctB64: string;
}>;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function aad(compartmentRef: string, keyEpoch: number): Uint8Array {
  return te.encode(
    JSON.stringify({ purpose: PURPOSE, compartmentRef, keyEpoch, version: 1 }),
  );
}

export async function importCompartmentKey(
  raw: Uint8Array,
): Promise<CryptoKey> {
  if (raw.length !== 32) {
    throw new Error("unsupported_factor: compartment key length");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealCompartmentJson(
  key: CryptoKey,
  compartmentRef: string,
  keyEpoch: number,
  value: BoundaryValue,
): Promise<SealedCompartmentBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const pt = te.encode(JSON.stringify(value));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(compartmentRef, keyEpoch) },
      key,
      pt,
    ),
  );
  pt.fill(0);
  return {
    version: 1,
    compartmentRef,
    keyEpoch,
    ivB64: b64(iv),
    ctB64: b64(ct),
  };
}

export async function openCompartmentJson<T>(
  key: CryptoKey,
  blob: SealedCompartmentBlob,
  expect: { compartmentRef: string; keyEpoch: number },
): Promise<T | null> {
  if (blob.version !== 1) return null;
  if (blob.compartmentRef !== expect.compartmentRef) return null;
  if (blob.keyEpoch !== expect.keyEpoch) return null;
  try {
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromB64(blob.ivB64),
          additionalData: aad(expect.compartmentRef, expect.keyEpoch),
        },
        key,
        fromB64(blob.ctB64),
      ),
    );
    const wire = JSON.parse(new TextDecoder().decode(pt));
    if (!isJsonObject(wire)) return null;
    return overlapCast<JsonObject, T>(wire);
  } catch {
    return null;
  }
}
