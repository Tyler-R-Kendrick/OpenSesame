/**
 * Two-layer PRF-and-code envelope (KEYS-E, AT-020/021/022).
 */

import {
  DURESS_PIN_PBKDF2_ITERATIONS,
  DuressKdfError,
  assertDuressKdfParams,
  isDuressKdfError,
} from "../keys/pin-floors.js";
import {
  type WrapperKind,
  survivingAlternateWrappers,
} from "../keys/wrappers.js";
import {
  PRF_CODE_PURPOSE,
  SLOT_PURPOSE,
  assertTriggerCodeLength,
  b64,
  fromB64,
  importAes,
  pbkdf2,
  te,
} from "./slot-bytes.js";

export type PrfAndCodeEnvelope = Readonly<{
  version: 1;
  profileId: string;
  vaultRef: string;
  policyRevision: number;
  keyEpoch: number;
  saltB64: string;
  outerIvB64: string;
  outerCtB64: string;
  iterations: number;
}>;

export type PrfAndCodeSealResult = Readonly<{
  envelope: PrfAndCodeEnvelope;
  survivingAlternateWrappers: readonly string[];
}>;

export async function sealPrfAndCode(input: {
  prfOutput: Uint8Array;
  code: string;
  compartmentKey: Uint8Array;
  profileId: string;
  vaultRef: string;
  policyRevision: number;
  keyEpoch: number;
  enrolledWrappers?: readonly WrapperKind[];
}): Promise<PrfAndCodeEnvelope> {
  const sealed = await sealPrfAndCodeWithDisclosure(input);
  return sealed.envelope;
}

export async function sealPrfAndCodeWithDisclosure(input: {
  prfOutput: Uint8Array;
  code: string;
  compartmentKey: Uint8Array;
  profileId: string;
  vaultRef: string;
  policyRevision: number;
  keyEpoch: number;
  enrolledWrappers?: readonly WrapperKind[];
}): Promise<PrfAndCodeSealResult> {
  if (input.prfOutput.length < 32) {
    throw new DuressKdfError("PRF output too short");
  }
  assertTriggerCodeLength(input.code);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = DURESS_PIN_PBKDF2_ITERATIONS;
  const codeKey = await pbkdf2(input.code, salt, iterations);
  const innerIv = crypto.getRandomValues(new Uint8Array(12));
  const innerKey = await importAes(codeKey);
  codeKey.fill(0);
  const aadInner = new Uint8Array(
    PRF_CODE_PURPOSE.length + SLOT_PURPOSE.length,
  );
  aadInner.set(PRF_CODE_PURPOSE, 0);
  aadInner.set(SLOT_PURPOSE, PRF_CODE_PURPOSE.length);
  const innerCt = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: innerIv, additionalData: aadInner },
      innerKey,
      input.compartmentKey,
    ),
  );
  const innerBlob = new Uint8Array(12 + innerCt.length);
  innerBlob.set(innerIv, 0);
  innerBlob.set(innerCt, 12);

  const prfKeyMat = await crypto.subtle.importKey(
    "raw",
    input.prfOutput,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const outerRaw = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: PRF_CODE_PURPOSE,
      },
      prfKeyMat,
      256,
    ),
  );
  const outerKey = await importAes(outerRaw);
  outerRaw.fill(0);
  const outerIv = crypto.getRandomValues(new Uint8Array(12));
  const aadOuter = te.encode(
    JSON.stringify({
      purpose: "prf_and_code",
      profileId: input.profileId,
      vaultRef: input.vaultRef,
      policyRevision: input.policyRevision,
      keyEpoch: input.keyEpoch,
    }),
  );
  const outerCt = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: outerIv, additionalData: aadOuter },
      outerKey,
      innerBlob,
    ),
  );
  const envelope: PrfAndCodeEnvelope = {
    version: 1,
    profileId: input.profileId,
    vaultRef: input.vaultRef,
    policyRevision: input.policyRevision,
    keyEpoch: input.keyEpoch,
    saltB64: b64(salt),
    outerIvB64: b64(outerIv),
    outerCtB64: b64(outerCt),
    iterations,
  };
  return {
    envelope,
    survivingAlternateWrappers: survivingAlternateWrappers(
      input.enrolledWrappers ?? [],
      { twoInputRequired: true, holdActive: false },
    ),
  };
}

export async function openPrfAndCode(input: {
  prfOutput: Uint8Array | null;
  code: string | null;
  envelope: PrfAndCodeEnvelope;
}): Promise<Uint8Array | null> {
  if (!input.prfOutput || !input.code) return null;
  if (input.prfOutput.length < 32) return null;
  assertDuressKdfParams({
    iterations: input.envelope.iterations,
    saltB64: input.envelope.saltB64,
  });
  try {
    assertTriggerCodeLength(input.code);
    const salt = fromB64(input.envelope.saltB64);
    const prfKeyMat = await crypto.subtle.importKey(
      "raw",
      input.prfOutput,
      "HKDF",
      false,
      ["deriveBits"],
    );
    const outerRaw = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt,
          info: PRF_CODE_PURPOSE,
        },
        prfKeyMat,
        256,
      ),
    );
    const outerKey = await importAes(outerRaw);
    outerRaw.fill(0);
    const aadOuter = te.encode(
      JSON.stringify({
        purpose: "prf_and_code",
        profileId: input.envelope.profileId,
        vaultRef: input.envelope.vaultRef,
        policyRevision: input.envelope.policyRevision,
        keyEpoch: input.envelope.keyEpoch,
      }),
    );
    const innerBlob = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromB64(input.envelope.outerIvB64),
          additionalData: aadOuter,
        },
        outerKey,
        fromB64(input.envelope.outerCtB64),
      ),
    );
    const codeKey = await pbkdf2(input.code, salt, input.envelope.iterations);
    const innerKey = await importAes(codeKey);
    codeKey.fill(0);
    const aadInner = new Uint8Array(
      PRF_CODE_PURPOSE.length + SLOT_PURPOSE.length,
    );
    aadInner.set(PRF_CODE_PURPOSE, 0);
    aadInner.set(SLOT_PURPOSE, PRF_CODE_PURPOSE.length);
    const key = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: innerBlob.slice(0, 12),
          additionalData: aadInner,
        },
        innerKey,
        innerBlob.slice(12),
      ),
    );
    return key;
  } catch (error) {
    if (error instanceof DuressKdfError) throw error;
    return null;
  }
}
