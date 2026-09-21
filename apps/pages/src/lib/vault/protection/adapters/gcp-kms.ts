/**
 * GCP Cloud KMS root protector (C05/C10).
 * Exact resource name, AAD from ProtectionContext, CRC32C integrity flags when
 * present. Injectible transport for unit tests (KP-31/KP-35/KP-36).
 */

import { ProtectionError } from "../errors.js";
import type {
  GcpKmsProtectorRecord,
  ProtectionContext,
  ProtectorAvailability,
  SealedBlobV1,
} from "../types.js";
import {
  aadBytesFromProtection,
  assertRootKey,
  assertWrappingSecret,
  b64ToBytes,
  bytesToB64,
  cloudBrowserAvailability,
  mintWrappingSecret,
  openRootUnderWrappingSecret,
  sealRootUnderWrappingSecret,
  zeroBytes,
} from "./cloud-wrapping-secret.js";

const CRYPTO_KEY_RE =
  /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[a-zA-Z0-9_-]+\/cryptoKeys\/[a-zA-Z0-9_-]+$/;
const CRYPTO_KEY_VERSION_RE =
  /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[a-zA-Z0-9_-]+\/cryptoKeys\/[a-zA-Z0-9_-]+\/cryptoKeyVersions\/[0-9]+$/;

export type GcpKmsEncryptRequest = {
  keyName: string;
  plaintext: Uint8Array;
  aad: Uint8Array;
};

export type GcpKmsEncryptResponse = {
  ciphertext: Uint8Array;
  /** Version resource name when the service returns one. */
  keyVersionName?: string;
  ciphertextCrc32c?: string;
  verifiedPlaintextCrc32c?: boolean;
  verifiedAdditionalAuthenticatedDataCrc32c?: boolean;
};

export type GcpKmsDecryptRequest = {
  keyName: string;
  ciphertext: Uint8Array;
  aad: Uint8Array;
  expectedKeyVersionName?: string;
};

export type GcpKmsDecryptResponse = {
  plaintext: Uint8Array;
  plaintextCrc32c?: string;
  verifiedCiphertextCrc32c?: boolean;
  verifiedAdditionalAuthenticatedDataCrc32c?: boolean;
};

/** Injectible Cloud KMS boundary — unit tests fake this. */
export type GcpKmsTransport = {
  encrypt(request: GcpKmsEncryptRequest): Promise<GcpKmsEncryptResponse>;
  decrypt(request: GcpKmsDecryptRequest): Promise<GcpKmsDecryptResponse>;
};

export type GcpKmsAdapterOptions = {
  transport?: GcpKmsTransport;
  authorization?: ProtectorAvailability["authorization"];
  /** Test seam for CORS capability reporting. */
  assumeBrowser?: boolean;
};

export type GcpKmsWrapInput = {
  context: ProtectionContext;
  rootKey: Uint8Array;
  keyName: string;
  connectionId: string;
  connectionConfigVersion: string;
};

export type GcpKmsWrapResult = {
  record: Omit<GcpKmsProtectorRecord, "proofStatus" | "lastEvidence">;
  localCapsule: SealedBlobV1;
};

export type GcpKmsUnwrapInput = {
  context: ProtectionContext;
  record: Pick<
    GcpKmsProtectorRecord,
    | "keyName"
    | "keyVersionName"
    | "wrappedSecretB64"
    | "localCapsule"
    | "aadB64"
  >;
};

export type GcpKmsProtector = {
  capabilities(): ProtectorAvailability;
  wrap(input: GcpKmsWrapInput): Promise<GcpKmsWrapResult>;
  unwrap(input: GcpKmsUnwrapInput): Promise<Uint8Array>;
  dispose(): Promise<void>;
};

export function assertGcpCryptoKeyName(keyName: string): void {
  if (!CRYPTO_KEY_RE.test(keyName)) {
    throw new ProtectionError(
      "malformed_encoding",
      "GCP KMS key name must be projects/.../locations/.../keyRings/.../cryptoKeys/....",
    );
  }
}

export function assertGcpKeyVersionName(keyVersionName: string): void {
  if (!CRYPTO_KEY_VERSION_RE.test(keyVersionName)) {
    throw new ProtectionError(
      "malformed_encoding",
      "GCP KMS key version name is malformed.",
    );
  }
}

/** CRC32C (Castagnoli) — integrity check only, not cryptographic auth. */
export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.byteLength; i += 1) {
    crc ^= data[i] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0x82f63b78 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32cDecimalString(data: Uint8Array): string {
  return String(crc32c(data));
}

export function assertCrcMatch(
  label: string,
  data: Uint8Array,
  reported: string | undefined,
): void {
  if (reported === undefined) return;
  const expected = crc32cDecimalString(data);
  if (reported !== expected) {
    throw new ProtectionError(
      "provider_denied",
      `GCP KMS ${label} CRC32C mismatch.`,
    );
  }
}

export function assertVerifiedFlag(
  label: string,
  flag: boolean | undefined,
): void {
  if (flag === undefined) return;
  if (flag !== true) {
    throw new ProtectionError(
      "provider_denied",
      `GCP KMS ${label} integrity flag was not verified.`,
    );
  }
}

async function gcpKmsWrap(
  transport: NonNullable<GcpKmsAdapterOptions["transport"]>,
  input: GcpKmsWrapInput,
): Promise<GcpKmsWrapResult> {
  if (!transport) {
    throw new ProtectionError(
      "unsupported_runtime",
      "GCP KMS wrap requires a native client or injected transport.",
    );
  }
  assertRootKey(input.rootKey);
  assertGcpCryptoKeyName(input.keyName);
  const aad = aadBytesFromProtection(input.context);

  const wrappingSecret = mintWrappingSecret();
  let localCapsule: SealedBlobV1;
  let wrapped: GcpKmsEncryptResponse;
  try {
    localCapsule = await sealRootUnderWrappingSecret(
      wrappingSecret,
      input.context,
      input.rootKey,
    );
    wrapped = await transport.encrypt({
      keyName: input.keyName,
      plaintext: wrappingSecret,
      aad,
    });
  } finally {
    zeroBytes(wrappingSecret);
  }

  assertVerifiedFlag("plaintext", wrapped.verifiedPlaintextCrc32c);
  assertVerifiedFlag("aad", wrapped.verifiedAdditionalAuthenticatedDataCrc32c);
  assertCrcMatch("ciphertext", wrapped.ciphertext, wrapped.ciphertextCrc32c);

  if (wrapped.keyVersionName !== undefined) {
    assertGcpKeyVersionName(wrapped.keyVersionName);
    if (!wrapped.keyVersionName.startsWith(`${input.keyName}/`)) {
      throw new ProtectionError(
        "provider_denied",
        "GCP KMS encrypt returned a key version outside the expected key.",
      );
    }
  }

  const record: Omit<GcpKmsProtectorRecord, "proofStatus" | "lastEvidence"> = {
    kind: "gcp-kms",
    protectorId: input.context.protectorId,
    keyName: input.keyName,
    connectionId: input.connectionId,
    connectionConfigVersion: input.connectionConfigVersion,
    wrappedSecretB64: bytesToB64(wrapped.ciphertext),
    localCapsule,
    aadB64: bytesToB64(aad),
  };
  if (wrapped.keyVersionName !== undefined) {
    record.keyVersionName = wrapped.keyVersionName;
  }

  return { localCapsule, record };
}

async function gcpKmsUnwrap(
  transport: NonNullable<GcpKmsAdapterOptions["transport"]>,
  input: GcpKmsUnwrapInput,
): Promise<Uint8Array> {
  if (!transport) {
    throw new ProtectionError(
      "unsupported_runtime",
      "GCP KMS unwrap requires a native client or injected transport.",
    );
  }
  assertGcpCryptoKeyName(input.record.keyName);
  const expectedAad = aadBytesFromProtection(input.context);
  const storedAad = b64ToBytes(input.record.aadB64);
  if (!bytesEqual(expectedAad, storedAad)) {
    throw new ProtectionError(
      "context_mismatch",
      "GCP KMS AAD does not match protection context.",
    );
  }
  if (input.record.keyVersionName !== undefined) {
    assertGcpKeyVersionName(input.record.keyVersionName);
  }

  const decryptRequest: GcpKmsDecryptRequest = {
    keyName: input.record.keyName,
    ciphertext: b64ToBytes(input.record.wrappedSecretB64),
    aad: expectedAad,
  };
  if (input.record.keyVersionName !== undefined) {
    decryptRequest.expectedKeyVersionName = input.record.keyVersionName;
  }

  const decrypted = await transport.decrypt(decryptRequest);

  assertVerifiedFlag("ciphertext", decrypted.verifiedCiphertextCrc32c);
  assertVerifiedFlag(
    "aad",
    decrypted.verifiedAdditionalAuthenticatedDataCrc32c,
  );
  assertCrcMatch("plaintext", decrypted.plaintext, decrypted.plaintextCrc32c);

  try {
    assertWrappingSecret(decrypted.plaintext);
    return await openRootUnderWrappingSecret(
      decrypted.plaintext,
      input.context,
      input.record.localCapsule,
    );
  } finally {
    zeroBytes(decrypted.plaintext);
  }
}

export function createGcpKmsProtector(
  options: GcpKmsAdapterOptions = {},
): GcpKmsProtector {
  const transport = options.transport;
  const authorization = options.authorization ?? "missing";
  const hasTransport = transport !== undefined;
  const assumeBrowser = options.assumeBrowser === true;

  return {
    capabilities(): ProtectorAvailability {
      return cloudBrowserAvailability(
        authorization,
        hasTransport,
        assumeBrowser,
      );
    },

    async wrap(
      input: Parameters<typeof gcpKmsWrap>[1],
    ): Promise<Awaited<ReturnType<typeof gcpKmsWrap>>> {
      if (!transport) {
        throw new ProtectionError(
          "unsupported_runtime",
          "createGcpKmsProtector wrap requires a native client or injected transport.",
        );
      }
      return gcpKmsWrap(transport, input);
    },

    async unwrap(
      input: Parameters<typeof gcpKmsUnwrap>[1],
    ): Promise<Uint8Array> {
      if (!transport) {
        throw new ProtectionError(
          "unsupported_runtime",
          "createGcpKmsProtector unwrap requires a native client or injected transport.",
        );
      }
      return gcpKmsUnwrap(transport, input);
    },

    async dispose(): Promise<void> {
      // Stateless.
    },
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
