/**
 * C05 shared cloud wrapping-secret envelope.
 *
 * Client mints a random 32-byte wrapping secret → domain-separated HKDF KEK
 * seals the root capsule locally. KMS only ever encrypts the 32-byte secret
 * (vault size independent). No clear-key CORS proxy.
 */

import { overlapCast } from "@opensesame/os-domain";
import { openRootCapsule, sealRootCapsule } from "../capsule.js";
import { ProtectionError } from "../errors.js";
import {
  DOMAIN_CLOUD_WRAP,
  ROOT_KEY_BYTES,
  WRAPPING_SECRET_BYTES,
} from "../limits.js";
import type {
  ProtectionContext,
  ProtectionPurpose,
  ProtectorAvailability,
  SealedBlobV1,
} from "../types.js";

export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function mintWrappingSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(WRAPPING_SECRET_BYTES));
}

export function assertWrappingSecret(secret: Uint8Array): void {
  if (secret.byteLength !== WRAPPING_SECRET_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Cloud wrapping secret must be ${WRAPPING_SECRET_BYTES} bytes.`,
    );
  }
}

export function assertRootKey(rootKey: Uint8Array): void {
  if (rootKey.byteLength !== ROOT_KEY_BYTES) {
    throw new ProtectionError(
      "invalid_key_length",
      `Root key must be ${ROOT_KEY_BYTES} bytes.`,
    );
  }
}

/** HKDF-SHA256 → AES-GCM-256 KEK bound to DOMAIN_CLOUD_WRAP. */
export async function deriveCloudKek(
  wrappingSecret: Uint8Array,
): Promise<CryptoKey> {
  assertWrappingSecret(wrappingSecret);
  const base = await crypto.subtle.importKey(
    "raw",
    overlapCast(wrappingSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(DOMAIN_CLOUD_WRAP),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealRootUnderWrappingSecret(
  wrappingSecret: Uint8Array,
  context: ProtectionContext,
  rootKey: Uint8Array,
): Promise<SealedBlobV1> {
  assertRootKey(rootKey);
  const kek = await deriveCloudKek(wrappingSecret);
  return sealRootCapsule(kek, context, rootKey);
}

export async function openRootUnderWrappingSecret(
  wrappingSecret: Uint8Array,
  expected: ProtectionContext,
  sealed: SealedBlobV1,
): Promise<Uint8Array> {
  const kek = await deriveCloudKek(wrappingSecret);
  return openRootCapsule(kek, expected, sealed);
}

/** Stable non-secret fields for AWS EncryptionContext / GCP AAD. */
export type CloudProtectionBinding = {
  domain: typeof DOMAIN_CLOUD_WRAP;
  vaultId: string;
  rootKeyId: string;
  rootEpoch: string;
  protectorId: string;
  purpose: ProtectionPurpose;
};

export function protectionContextFields(
  context: ProtectionContext,
): CloudProtectionBinding {
  return {
    domain: DOMAIN_CLOUD_WRAP,
    vaultId: context.vaultId,
    rootKeyId: context.rootKeyId,
    rootEpoch: String(context.rootEpoch),
    protectorId: context.protectorId,
    purpose: context.purpose,
  };
}

export function encryptionContextFromProtection(
  context: ProtectionContext,
): CloudProtectionBinding {
  return protectionContextFields(context);
}

export function aadBytesFromProtection(context: ProtectionContext): Uint8Array {
  const fields = protectionContextFields(context);
  const ordered = {
    domain: fields.domain,
    protectorId: fields.protectorId,
    purpose: fields.purpose,
    rootEpoch: fields.rootEpoch,
    rootKeyId: fields.rootKeyId,
    vaultId: fields.vaultId,
  } satisfies CloudProtectionBinding;
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export function bindingEquals(
  left: CloudProtectionBinding,
  right: CloudProtectionBinding,
): boolean {
  return (
    left.domain === right.domain &&
    left.vaultId === right.vaultId &&
    left.rootKeyId === right.rootKeyId &&
    left.rootEpoch === right.rootEpoch &&
    left.protectorId === right.protectorId &&
    left.purpose === right.purpose
  );
}

export function stringMapToBinding(
  map: Record<string, string>,
): CloudProtectionBinding {
  const domain = map.domain;
  const vaultId = map.vaultId;
  const rootKeyId = map.rootKeyId;
  const rootEpoch = map.rootEpoch;
  const protectorId = map.protectorId;
  const purpose = map.purpose;
  if (
    domain !== DOMAIN_CLOUD_WRAP ||
    vaultId === undefined ||
    rootKeyId === undefined ||
    rootEpoch === undefined ||
    protectorId === undefined ||
    (purpose !== "human-vault-root" && purpose !== "workload-root")
  ) {
    throw new ProtectionError(
      "context_mismatch",
      "Cloud protection binding fields are incomplete or invalid.",
    );
  }
  return {
    domain,
    vaultId,
    rootKeyId,
    rootEpoch,
    protectorId,
    purpose,
  };
}

export function zeroBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

export function isBrowserRuntime(): boolean {
  return globalThis.window !== undefined;
}

/**
 * Browser pages cannot call provider KMS APIs directly (CORS). Report the
 * native-client requirement instead of adding a clear wrapping-secret proxy.
 */
export function cloudBrowserAvailability(
  authorization: ProtectorAvailability["authorization"],
  hasInjectedTransport: boolean,
  assumeBrowser = false,
): ProtectorAvailability {
  if ((assumeBrowser || isBrowserRuntime()) && !hasInjectedTransport) {
    return {
      implementation: "implemented",
      runtime: "requires-native-client",
      authorization,
      reasonCode: "cors-blocks-direct-cloud-kms",
    };
  }
  return {
    implementation: "implemented",
    runtime: "available",
    authorization,
  };
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

function isPrivateOrLinkLocalIpv4(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export type CloudEndpointKind = "aws-kms" | "azure-key-vault" | "gcp-kms";

/**
 * KP-36: validate provider endpoints before token/key-bearing requests.
 * Rejects non-HTTPS, credentials-in-URL, localhost/metadata, and off-allowlist hosts.
 */
export function assertAllowedCloudEndpoint(
  rawUrl: string,
  kind: CloudEndpointKind,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProtectionError(
      "ssrf_blocked",
      "Cloud endpoint URL is malformed.",
    );
  }
  if (url.protocol !== "https:") {
    throw new ProtectionError(
      "ssrf_blocked",
      "Cloud endpoints must use HTTPS.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProtectionError(
      "ssrf_blocked",
      "Cloud endpoints must not embed credentials.",
    );
  }
  const host = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    isPrivateOrLinkLocalIpv4(host) ||
    host.includes(":")
  ) {
    throw new ProtectionError(
      "ssrf_blocked",
      "Cloud endpoint host is not allowlisted.",
    );
  }
  if (!hostAllowedForKind(host, kind)) {
    throw new ProtectionError(
      "ssrf_blocked",
      "Cloud endpoint host is not allowlisted.",
    );
  }
  return url;
}

function hostAllowedForKind(host: string, kind: CloudEndpointKind): boolean {
  switch (kind) {
    case "aws-kms":
      return (
        /^kms\.[a-z0-9-]+\.amazonaws\.com$/.test(host) ||
        /^kms\.[a-z0-9-]+\.amazonaws\.com\.cn$/.test(host)
      );
    case "azure-key-vault":
      return (
        host.endsWith(".vault.azure.net") ||
        host.endsWith(".vault.azure.cn") ||
        host.endsWith(".vault.usgovcloudapi.net") ||
        host.endsWith(".managedhsm.azure.net") ||
        host.endsWith(".managedhsm.azure.cn")
      );
    case "gcp-kms":
      return (
        host === "cloudkms.googleapis.com" ||
        /^cloudkms\.[a-z0-9-]+\.rep\.googleapis\.com$/.test(host)
      );
  }
}

export function awsKmsEndpointForRegion(region: string): string {
  if (!/^[a-z0-9-]+$/.test(region)) {
    throw new ProtectionError("ssrf_blocked", "AWS region is malformed.");
  }
  const endpoint = `https://kms.${region}.amazonaws.com/`;
  assertAllowedCloudEndpoint(endpoint, "aws-kms");
  return endpoint;
}
