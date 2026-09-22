/**
 * Code-gated profile slot seal/open (KEYS-B/C).
 */

import {
  DURESS_PIN_PBKDF2_ITERATIONS,
  DuressKdfError,
  assertDuressKdfParams,
} from "../keys/pin-floors.js";
import {
  assertTriggerCodeLength,
  b64,
  fromB64,
  importAes,
  pbkdf2,
  te,
} from "./slot-bytes.js";

export const MAX_SLOTS = 8;

export type SealedSlot = Readonly<{
  version: 1;
  slotId: string;
  profileId: string;
  vaultRef: string;
  deviceBindingRef: string;
  policyRevision: number;
  keyEpoch: number;
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
  iterations: number;
}>;

export type SlotPlaintext = Readonly<{
  compartmentKey: Uint8Array;
  actionCapability: Uint8Array | null;
  presentation: string;
}>;

function aadFor(slot: Omit<SealedSlot, "ivB64" | "ciphertextB64">): Uint8Array {
  return te.encode(
    JSON.stringify({
      purpose: "slot",
      version: slot.version,
      slotId: slot.slotId,
      profileId: slot.profileId,
      vaultRef: slot.vaultRef,
      deviceBindingRef: slot.deviceBindingRef,
      policyRevision: slot.policyRevision,
      keyEpoch: slot.keyEpoch,
      iterations: slot.iterations,
    }),
  );
}

export async function sealProfileSlot(input: {
  code: string;
  slotId: string;
  profileId: string;
  vaultRef: string;
  deviceBindingRef: string;
  policyRevision: number;
  keyEpoch: number;
  plaintext: SlotPlaintext;
  iterations?: number;
}): Promise<SealedSlot> {
  assertTriggerCodeLength(input.code);
  const iterations = input.iterations ?? DURESS_PIN_PBKDF2_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = await pbkdf2(input.code, salt, iterations);
  const key = await importAes(keyBytes);
  keyBytes.fill(0);
  const meta = {
    version: 1 as const,
    slotId: input.slotId,
    profileId: input.profileId,
    vaultRef: input.vaultRef,
    deviceBindingRef: input.deviceBindingRef,
    policyRevision: input.policyRevision,
    keyEpoch: input.keyEpoch,
    saltB64: b64(salt),
    iterations,
  };
  const pres = te.encode(input.plaintext.presentation);
  const cap = input.plaintext.actionCapability ?? new Uint8Array(0);
  const body = new Uint8Array(
    4 + input.plaintext.compartmentKey.length + 4 + cap.length + pres.length,
  );
  const view = new DataView(body.buffer);
  let o = 0;
  view.setUint32(o, input.plaintext.compartmentKey.length);
  o += 4;
  body.set(input.plaintext.compartmentKey, o);
  o += input.plaintext.compartmentKey.length;
  view.setUint32(o, cap.length);
  o += 4;
  body.set(cap, o);
  o += cap.length;
  body.set(pres, o);

  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(meta) },
      key,
      body,
    ),
  );
  return { ...meta, ivB64: b64(iv), ciphertextB64: b64(ct) };
}

export async function openProfileSlot(
  code: string,
  slot: SealedSlot,
  expect: {
    vaultRef: string;
    deviceBindingRef: string;
    policyRevision: number;
    keyEpoch: number;
  },
): Promise<SlotPlaintext | null> {
  if (slot.version !== 1) return null;
  if (slot.vaultRef !== expect.vaultRef) return null;
  if (slot.deviceBindingRef !== expect.deviceBindingRef) return null;
  if (slot.policyRevision !== expect.policyRevision) return null;
  if (slot.keyEpoch !== expect.keyEpoch) return null;
  assertDuressKdfParams({
    iterations: slot.iterations,
    saltB64: slot.saltB64,
  });
  try {
    assertTriggerCodeLength(code);
    const salt = fromB64(slot.saltB64);
    const iv = fromB64(slot.ivB64);
    const keyBytes = await pbkdf2(code, salt, slot.iterations);
    const key = await importAes(keyBytes);
    keyBytes.fill(0);
    const meta = {
      version: 1 as const,
      slotId: slot.slotId,
      profileId: slot.profileId,
      vaultRef: slot.vaultRef,
      deviceBindingRef: slot.deviceBindingRef,
      policyRevision: slot.policyRevision,
      keyEpoch: slot.keyEpoch,
      saltB64: slot.saltB64,
      iterations: slot.iterations,
    };
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(meta) },
        key,
        fromB64(slot.ciphertextB64),
      ),
    );
    const view = new DataView(pt.buffer);
    let o = 0;
    const klen = view.getUint32(o);
    o += 4;
    const compartmentKey = pt.slice(o, o + klen);
    o += klen;
    const clen = view.getUint32(o);
    o += 4;
    const actionCapability = clen > 0 ? pt.slice(o, o + clen) : null;
    o += clen;
    const presentation = new TextDecoder().decode(pt.slice(o));
    return { compartmentKey, actionCapability, presentation };
  } catch (error) {
    if (error instanceof DuressKdfError) throw error;
    return null;
  }
}

export function createIndependentCompartmentKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
