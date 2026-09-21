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

export { LEGACY_WEBAUTHN_PRF_DOMAIN };

const PRF_ADAPTER_VERSION = "webauthn-prf/v1";

export type WebauthnPrfCapabilityDetails = {
  credentialsApi: boolean;
  publicKeyCredential: boolean;
  hostOk: boolean;
  /** From getClientCapabilities().extensions when present. */
  extensionPrf: boolean | "unknown";
  /**
   * True only when extension results include a usable `results.first`.
   * `enabled: true` alone never sets this (KP-22).
   */
  usablePrfOutput: boolean;
  /** Soft advertise flag — not a KEK claim. */
  prfExtensionAdvertised: boolean;
};

export type WebauthnPrfCapabilityReport = {
  availability: ProtectorAvailability;
  details: WebauthnPrfCapabilityDetails;
};

type ClientCapabilitiesLike = {
  extensions?: { prf?: boolean };
};

/**
 * Honest PRF availability: platform UV / SSO is never reported as a KEK.
 * A usable PRF output is required before wrap (KP-22).
 */

async function resolveExtensionPrf(
  publicKeyCredential: boolean,
  injected: ClientCapabilitiesLike | null | undefined,
): Promise<boolean | "unknown"> {
  if (injected) {
    return injected.extensions?.prf === true;
  }
  if (
    !publicKeyCredential ||
    globalThis.PublicKeyCredential === undefined ||
    PublicKeyCredential.getClientCapabilities === undefined
  ) {
    return "unknown";
  }
  try {
    const caps = await PublicKeyCredential.getClientCapabilities();
    const prfFlag = caps["extension:prf"] ?? caps.prf;
    if (prfFlag === true) return true;
    if (prfFlag === false) return false;
    return "unknown";
  } catch {
    return "unknown";
  }
}

function prfReasonCode(input: {
  hostOk: boolean;
  credentialsReady: boolean;
  publicKeyCredential: boolean;
  extensionPrf: boolean | "unknown";
  usablePrfOutput: boolean;
}): string {
  if (!input.hostOk) return "invalid_webauthn_host";
  if (!input.credentialsReady || !input.publicKeyCredential) {
    return "webauthn_missing";
  }
  if (input.extensionPrf === false) return "prf_extension_unavailable";
  if (input.usablePrfOutput) return "prf_output_ready";
  return "prf_requires_ceremony";
}

function probePlatformCredentials(injected: boolean): {
  credentialsApi: boolean;
  publicKeyCredential: boolean;
  credentialsReady: boolean;
} {
  const credentialsApi =
    globalThis.navigator?.credentials?.create !== undefined;
  if (injected) {
    return {
      credentialsApi,
      publicKeyCredential: true,
      credentialsReady: true,
    };
  }
  return {
    credentialsApi,
    publicKeyCredential: globalThis.PublicKeyCredential !== undefined,
    credentialsReady: credentialsApi,
  };
}

export async function webauthnPrfCapabilities(options?: {
  hostname?: string;
  href?: string;
  extensionResults?: AuthenticationExtensionsClientOutputs;
  clientCapabilities?: ClientCapabilitiesLike | null;
}): Promise<WebauthnPrfCapabilityReport> {
  const host = checkWebauthnHost(options?.hostname, options?.href);
  const platform = probePlatformCredentials(
    options?.clientCapabilities !== undefined,
  );
  const { credentialsApi, publicKeyCredential, credentialsReady } = platform;
  const usablePrfOutput = hasUsablePrfOutput(options?.extensionResults);
  const prfExtensionAdvertised = prfExtensionSupported(
    options?.extensionResults,
  );
  const extensionPrf = await resolveExtensionPrf(
    publicKeyCredential,
    options?.clientCapabilities,
  );
  const runtimeReady =
    host.ok &&
    credentialsReady &&
    publicKeyCredential &&
    extensionPrf !== false;
  const reasonCode = prfReasonCode({
    hostOk: host.ok,
    credentialsReady,
    publicKeyCredential,
    extensionPrf,
    usablePrfOutput,
  });
  const availability: ProtectorAvailability = {
    implementation: "implemented",
    runtime: runtimeReady ? "available" : "unavailable",
    authorization: "not-required",
    reasonCode,
  };
  return {
    availability,
    details: {
      credentialsApi,
      publicKeyCredential,
      hostOk: host.ok,
      extensionPrf,
      usablePrfOutput,
      prfExtensionAdvertised,
    },
  };
}

export function browserEvidence(evidenceRef: string): VerificationEvidence {
  return {
    kind: "browser",
    implementationVersion: PRF_ADAPTER_VERSION,
    testedAt: new Date().toISOString(),
    evidenceRef,
  };
}

export type WebauthnPrfAdapterOptions = {
  sessionGeneration?: number;
  createCeremony?: typeof createPasskeyUnlockCeremony;
  getCeremonyFor?: typeof getPasskeyUnlockCeremonyFor;
};

export { createWebauthnPrfProtector } from "./webauthn-prf-ops.js";

export function mapPrfToProtectionError<Thrown>(
  error: Thrown,
): ProtectionError {
  if (error instanceof ProtectionError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ProtectionError("canceled", error.message);
  }
  if (error instanceof PrfCeremonyError) {
    if (error.code === "canceled") {
      return new ProtectionError("canceled", error.message);
    }
    if (
      error.code === "invalid_host" ||
      error.code === "wrong_rp" ||
      error.code === "origin_mismatch"
    ) {
      return new ProtectionError("context_mismatch", error.message);
    }
    if (error.code === "wrong_credential") {
      return new ProtectionError("enrollment_proof_failed", error.message);
    }
    return new ProtectionError("unsupported_runtime", error.message);
  }
  if (error instanceof Error) {
    return new ProtectionError("unavailable", error.message);
  }
  return new ProtectionError("unavailable", "Passkey ceremony failed.");
}

/** Re-exports for PRF swarm consumers that import the adapter path. */
export {
  assertUsablePrfOutput,
  b64ToBytes,
  createPasskeyUnlockCeremony,
  getPasskeyUnlockCeremony,
  getPasskeyUnlockCeremonyFor,
  hasUsablePrfOutput,
  kekFromWebauthnPrf,
  listPasskeyUnlockRecords,
  prfExtensionSupported,
  readPrfFirst,
  unwrapVaultKeyWithPrf,
  withPasskeyUnlock,
  wrapVaultKeyWithPrf,
};
