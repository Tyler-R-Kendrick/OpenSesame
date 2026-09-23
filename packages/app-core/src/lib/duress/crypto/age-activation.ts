/**
 * Age-sealed activation packages (KEYS-B).
 * Opens with an age identity alone — no protected vault-root bootstrap required.
 */

import {
  decryptWithAge,
  encryptWithAge,
  generateAgeKeyPair,
  isAgeIdentity,
  isAgeRecipient,
} from "../../age-keys.js";
import { DuressKdfError } from "../keys/pin-floors.js";

const te = new TextEncoder();
const td = new TextDecoder();
const PURPOSE = "opensesame/duress/age-activation/v1";

export type AgeActivationPackage = Readonly<{
  version: 1;
  profileId: string;
  vaultRef: string;
  policyRevision: number;
  keyEpoch: number;
  ciphertextB64: string;
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

type AgeBindingHeaderMeta = Readonly<{
  profileId: string;
  vaultRef: string;
  policyRevision: number;
  keyEpoch: number;
}>;

function bindingHeader(meta: AgeBindingHeaderMeta): string {
  return JSON.stringify({
    purpose: PURPOSE,
    version: 1,
    profileId: meta.profileId,
    vaultRef: meta.vaultRef,
    policyRevision: meta.policyRevision,
    keyEpoch: meta.keyEpoch,
  });
}

/**
 * Seal a compartment key to age recipients with domain/context binding
 * embedded in the plaintext framing (fail-closed on mismatch at open).
 */
export async function sealAgeActivation(input: {
  compartmentKey: Uint8Array;
  recipients: readonly string[];
  profileId: string;
  vaultRef: string;
  policyRevision: number;
  keyEpoch: number;
}): Promise<AgeActivationPackage> {
  if (input.compartmentKey.length !== 32) {
    throw new DuressKdfError("compartment key must be 32 bytes");
  }
  if (input.recipients.length === 0) {
    throw new DuressKdfError("age recipients required");
  }
  for (const r of input.recipients) {
    if (!isAgeRecipient(r)) throw new DuressKdfError("invalid age recipient");
  }
  const header = bindingHeader(input);
  const headerBytes = te.encode(header);
  const framed = new Uint8Array(
    4 + headerBytes.length + input.compartmentKey.length,
  );
  const view = new DataView(framed.buffer);
  view.setUint32(0, headerBytes.length);
  framed.set(headerBytes, 4);
  framed.set(input.compartmentKey, 4 + headerBytes.length);
  const ct = await encryptWithAge(framed, input.recipients);
  return {
    version: 1,
    profileId: input.profileId,
    vaultRef: input.vaultRef,
    policyRevision: input.policyRevision,
    keyEpoch: input.keyEpoch,
    ciphertextB64: b64(ct),
  };
}

export async function openAgeActivation(input: {
  identity: string;
  package: AgeActivationPackage;
  expect: {
    vaultRef: string;
    policyRevision: number;
    keyEpoch: number;
  };
}): Promise<Uint8Array | null> {
  if (input.package.version !== 1) return null;
  if (input.package.vaultRef !== input.expect.vaultRef) return null;
  if (input.package.policyRevision !== input.expect.policyRevision) return null;
  if (input.package.keyEpoch !== input.expect.keyEpoch) return null;
  if (!isAgeIdentity(input.identity)) {
    throw new DuressKdfError("invalid age identity");
  }
  try {
    const plain = await decryptWithAge(
      fromB64(input.package.ciphertextB64),
      input.identity,
    );
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const hlen = view.getUint32(0);
    const header = td.decode(plain.slice(4, 4 + hlen));
    const headerMeta = {
      profileId: input.package.profileId,
      vaultRef: input.package.vaultRef,
      policyRevision: input.package.policyRevision,
      keyEpoch: input.package.keyEpoch,
    } satisfies AgeBindingHeaderMeta;
    const expected = bindingHeader(headerMeta);
    if (header !== expected) return null;
    const key = plain.slice(4 + hlen);
    if (key.length !== 32) return null;
    return key;
  } catch {
    return null;
  }
}

/** Disposable fixture helper — never for production enrollment. */
export async function mintDisposableAgePair(): Promise<{
  identity: string;
  recipient: string;
}> {
  return generateAgeKeyPair();
}
