/**
 * WebAuthn PRF root protector adapter (KP-22/KP-23).
 *
 * Ceremony + KEK derivation stay on the legacy domain
 * `opensesame/vault/webauthn-prf/v1` via `kekFromWebauthnPrf`. This module does
 * not mutate unlock wraps — failed enroll must never call `withPasskeyUnlock`.
 */

import { b64ToBytes, bytesToB64 } from "../../crypto.js";
import {
  type PasskeyCeremony,
  type PasskeyUnlockCeremonyResult,
  type PasskeyUnlockRecord,
  checkWebauthnHost,
  createPasskeyUnlockCeremony,
  getPasskeyUnlockCeremony,
  getPasskeyUnlockCeremonyFor,
  kekFromWebauthnPrf,
  listPasskeyUnlockRecords,
  unwrapVaultKeyWithPrf,
  webauthnRpId,
  withPasskeyUnlock,
  wrapVaultKeyWithPrf,
} from "../../unlock-methods.js";
import {
  type AuthorizedEnrollmentRequest,
  type AuthorizedOpenRequest,
  type AuthorizedProofRequest,
  type ClientRootKeyHandle,
  type KeyProtectorAdapter,
  type PendingProtection,
  type ProtectionProof,
  assertNotCanceled,
  assertSessionGeneration,
  mintRootKeyHandle,
} from "../adapter.js";
import { ProtectionError } from "../errors.js";
import { LEGACY_WEBAUTHN_PRF_DOMAIN } from "../limits.js";
import type {
  ProtectorAvailability,
  VerificationEvidence,
  WebauthnPrfProtectorRecord,
} from "../types.js";
import {
  PrfCeremonyError,
  assertUsablePrfOutput,
  hasUsablePrfOutput,
  prfExtensionSupported,
  readPrfFirst,
} from "./webauthn-prf-output.js";

import {
  type WebauthnPrfAdapterOptions,
  browserEvidence,
  mapPrfToProtectionError,
} from "./webauthn-prf.js";
export function protectorToUnlockRecord(
  record: WebauthnPrfProtectorRecord,
): PasskeyUnlockRecord {
  return {
    credentialIdB64: record.credentialIdB64,
    userIdB64: bytesToB64(new Uint8Array(0)),
    prfSaltB64: record.saltB64,
    wrap: {
      ivB64: record.wrap.ivB64,
      ctB64: record.wrap.ctB64,
    },
  };
}

async function webauthnPrfEnroll(
  createCeremony: typeof createPasskeyUnlockCeremony,
  sessionGeneration: number,
  request: AuthorizedEnrollmentRequest,
): Promise<PendingProtection> {
  assertNotCanceled(request.signal);
  assertSessionGeneration(sessionGeneration ?? 0, request.sessionGeneration);
  let ceremony: PasskeyCeremony;
  try {
    ceremony = await createCeremony(webauthnRpId(), request.signal);
  } catch (error) {
    throw mapPrfToProtectionError(error);
  }
  assertUsablePrfOutput(ceremony.prfOutput);
  const protector = await protectorFromPrfMaterial({
    rootKey: request.rootHandle.bytes,
    prfOutput: ceremony.prfOutput,
    prfSalt: ceremony.prfSalt,
    credentialId: ceremony.credential.rawId,
    userId: ceremony.userId,
    protectorId: request.context.protectorId,
  });
  if (!protector.lastEvidence) {
    throw new ProtectionError(
      "enrollment_proof_failed",
      "WebAuthn PRF enrollment produced no evidence.",
    );
  }
  return {
    record: protector,
    proof: { ok: true, evidence: protector.lastEvidence },
  };
}

async function webauthnPrfProve(
  getCeremonyFor: typeof getPasskeyUnlockCeremonyFor,
  sessionGeneration: number,
  request: AuthorizedProofRequest,
): Promise<ProtectionProof> {
  assertNotCanceled(request.signal);
  assertSessionGeneration(sessionGeneration ?? 0, request.sessionGeneration);
  if (request.record.kind !== "webauthn-prf") {
    throw new ProtectionError(
      "malformed_encoding",
      "webauthn-prf prove requires a webauthn-prf record.",
    );
  }
  const unlockRecord = protectorToUnlockRecord(request.record);
  try {
    await getCeremonyFor([unlockRecord], {
      rpId: request.record.rpId,
      signal: request.signal,
      credentialIdB64: unlockRecord.credentialIdB64,
    });
  } catch (error) {
    throw mapPrfToProtectionError(error);
  }
  return {
    ok: true,
    evidence: browserEvidence(
      `${LEGACY_WEBAUTHN_PRF_DOMAIN}:prove:${request.record.protectorId}`,
    ),
  };
}

async function webauthnPrfOpen(
  getCeremonyFor: typeof getPasskeyUnlockCeremonyFor,
  sessionGeneration: number,
  request: AuthorizedOpenRequest,
): Promise<ClientRootKeyHandle> {
  assertNotCanceled(request.signal);
  assertSessionGeneration(sessionGeneration ?? 0, request.sessionGeneration);
  if (request.record.kind !== "webauthn-prf") {
    throw new ProtectionError(
      "malformed_encoding",
      "webauthn-prf open requires a webauthn-prf record.",
    );
  }
  const unlockRecord = protectorToUnlockRecord(request.record);
  let selected: PasskeyUnlockCeremonyResult;
  try {
    selected = await getCeremonyFor([unlockRecord], {
      rpId: request.record.rpId,
      signal: request.signal,
      credentialIdB64: unlockRecord.credentialIdB64,
    });
  } catch (error) {
    throw mapPrfToProtectionError(error);
  }
  const rootKey = await unwrapVaultKeyWithPrf(
    selected.record,
    selected.prfOutput,
  );
  return mintRootKeyHandle(request.context, rootKey);
}

/** Copy a view so wrap does not read bytes outside the view. */
function copiedBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  return value.slice(0);
}

/** Wrap a VRK with a PRF output this caller already holds. Does not start a ceremony. */
export async function protectorFromPrfMaterial(input: {
  rootKey: Uint8Array;
  prfOutput: ArrayBuffer;
  prfSalt: Uint8Array;
  credentialId: ArrayBuffer | Uint8Array;
  userId: ArrayBuffer | Uint8Array;
  protectorId: string;
}): Promise<WebauthnPrfProtectorRecord> {
  assertUsablePrfOutput(input.prfOutput);
  const wrapped = await wrapVaultKeyWithPrf(
    input.rootKey,
    input.prfOutput,
    input.prfSalt,
    copiedBuffer(input.credentialId),
    copiedBuffer(input.userId),
  );
  const opened = await unwrapVaultKeyWithPrf(wrapped, input.prfOutput);
  try {
    if (
      opened.byteLength !== input.rootKey.byteLength ||
      opened.some((byte, index) => byte !== input.rootKey[index])
    ) {
      throw new ProtectionError(
        "enrollment_proof_failed",
        "WebAuthn PRF enrollment recovered a different root key.",
      );
    }
  } finally {
    opened.fill(0);
  }
  return {
    kind: "webauthn-prf",
    protectorId: input.protectorId,
    legacy: false,
    credentialIdB64: wrapped.credentialIdB64,
    rpId: webauthnRpId(),
    saltB64: wrapped.prfSaltB64,
    wrap: { ivB64: wrapped.wrap.ivB64, ctB64: wrapped.wrap.ctB64 },
    userVerification: "required",
    proofStatus: "verified",
    lastEvidence: browserEvidence(
      `${LEGACY_WEBAUTHN_PRF_DOMAIN}:${wrapped.credentialIdB64}`,
    ),
  };
}

export function createWebauthnPrfProtector(
  options: WebauthnPrfAdapterOptions = {},
): KeyProtectorAdapter {
  const createCeremony = options.createCeremony ?? createPasskeyUnlockCeremony;
  const getCeremonyFor = options.getCeremonyFor ?? getPasskeyUnlockCeremonyFor;
  const sessionGeneration = options.sessionGeneration ?? 0;

  return {
    capabilities(): ProtectorAvailability {
      const host = checkWebauthnHost();
      const ready =
        host.ok &&
        globalThis.navigator?.credentials?.create !== undefined &&
        globalThis.PublicKeyCredential !== undefined;
      return {
        implementation: "implemented",
        runtime: ready ? "available" : "unavailable",
        authorization: "not-required",
        reasonCode: ready ? "prf_requires_ceremony" : "webauthn_missing",
      };
    },
    enroll: (request) =>
      webauthnPrfEnroll(createCeremony, sessionGeneration, request),
    prove: (request) =>
      webauthnPrfProve(getCeremonyFor, sessionGeneration, request),
    open: (request) =>
      webauthnPrfOpen(getCeremonyFor, sessionGeneration, request),
    async dispose(): Promise<void> {
      /* no retained secrets */
    },
  };
}
