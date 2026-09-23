/**
 * Azure Key Vault Keys root protector (C05/C10).
 * wrap/unwrap with RSA-OAEP-256 only on a versioned key id. Rejects Secrets
 * endpoints and RSA1_5. Injectible transport for unit tests (KP-31/KP-34/KP-36).
 */

import type {
  AzureKeyVaultKeysProtectorRecord,
  ProtectionContext,
  ProtectorAvailability,
  SealedBlobV1,
} from "@opensesame/vault-core";
import { ProtectionError } from "../errors.js";
import {
  assertAllowedCloudEndpoint,
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

export const AZURE_WRAP_ALGORITHM = "RSA-OAEP-256" as const;

const VERSIONED_KEY_PATH =
  /^\/keys\/([^/]+)\/([0-9a-fA-F]{32}|[0-9a-fA-F-]{36}|[a-zA-Z0-9-]+)$/;

export type AzureWrapKeyRequest = {
  versionedKeyId: string;
  algorithm: typeof AZURE_WRAP_ALGORITHM;
  plaintext: Uint8Array;
};

export type AzureWrapKeyResponse = {
  versionedKeyId: string;
  algorithm: typeof AZURE_WRAP_ALGORITHM;
  ciphertext: Uint8Array;
};

export type AzureUnwrapKeyRequest = {
  versionedKeyId: string;
  algorithm: typeof AZURE_WRAP_ALGORITHM;
  ciphertext: Uint8Array;
};

export type AzureUnwrapKeyResponse = {
  versionedKeyId: string;
  algorithm: typeof AZURE_WRAP_ALGORITHM;
  plaintext: Uint8Array;
};

/** Injectible Key Vault Keys boundary — unit tests fake this. */
export type AzureKeyVaultKeysTransport = {
  wrapKey(request: AzureWrapKeyRequest): Promise<AzureWrapKeyResponse>;
  unwrapKey(request: AzureUnwrapKeyRequest): Promise<AzureUnwrapKeyResponse>;
};

export type AzureKeyVaultKeysAdapterOptions = {
  transport?: AzureKeyVaultKeysTransport;
  authorization?: ProtectorAvailability["authorization"];
  /** Test seam for CORS capability reporting. */
  assumeBrowser?: boolean;
};

export type AzureKeyVaultKeysWrapInput = {
  context: ProtectionContext;
  rootKey: Uint8Array;
  versionedKeyId: string;
  connectionId: string;
  connectionConfigVersion: string;
  tenantId: string;
};

export type AzureKeyVaultKeysWrapResult = {
  record: Omit<
    AzureKeyVaultKeysProtectorRecord,
    "proofStatus" | "lastEvidence"
  >;
  localCapsule: SealedBlobV1;
};

export type AzureKeyVaultKeysUnwrapInput = {
  context: ProtectionContext;
  record: Pick<
    AzureKeyVaultKeysProtectorRecord,
    "versionedKeyId" | "algorithm" | "wrappedSecretB64" | "localCapsule"
  >;
};

export type AzureKeyVaultKeysProtector = {
  capabilities(): ProtectorAvailability;
  wrap(input: AzureKeyVaultKeysWrapInput): Promise<AzureKeyVaultKeysWrapResult>;
  unwrap(input: AzureKeyVaultKeysUnwrapInput): Promise<Uint8Array>;
  dispose(): Promise<void>;
};

export function assertAzureVersionedKeyId(versionedKeyId: string): URL {
  let url: URL;
  try {
    url = new URL(versionedKeyId);
  } catch {
    throw new ProtectionError(
      "malformed_encoding",
      "Azure Key Vault key id must be an absolute HTTPS URL.",
    );
  }
  assertAllowedCloudEndpoint(url.toString(), "azure-key-vault");

  const path = url.pathname.replace(/\/+$/, "");
  if (path.includes("/secrets/")) {
    throw new ProtectionError(
      "malformed_encoding",
      "Azure Key Vault Secrets endpoints cannot protect vault roots; use Keys.",
    );
  }
  if (path.includes("/certificates/")) {
    throw new ProtectionError(
      "malformed_encoding",
      "Azure Key Vault certificate endpoints are not supported for root protection.",
    );
  }
  const match = VERSIONED_KEY_PATH.exec(path);
  if (!match) {
    throw new ProtectionError(
      "malformed_encoding",
      "Azure Key Vault key id must be versioned (/keys/{name}/{version}).",
    );
  }
  return url;
}

export function assertAzureWrapAlgorithm(algorithm: string): void {
  if (algorithm === "RSA1_5" || algorithm === "RSA-OAEP") {
    throw new ProtectionError(
      "malformed_encoding",
      "Azure Key Vault root protection refuses RSA1_5 and SHA-1 OAEP.",
    );
  }
  if (algorithm !== AZURE_WRAP_ALGORITHM) {
    throw new ProtectionError(
      "malformed_encoding",
      "Azure Key Vault root protection requires RSA-OAEP-256.",
    );
  }
}

async function azureKvWrap(
  transport: NonNullable<AzureKeyVaultKeysAdapterOptions["transport"]>,

  input: AzureKeyVaultKeysWrapInput,
): Promise<AzureKeyVaultKeysWrapResult> {
  if (!transport) {
    throw new ProtectionError(
      "unsupported_runtime",
      "Azure Key Vault wrap requires a native client or injected transport.",
    );
  }
  assertRootKey(input.rootKey);
  const keyUrl = assertAzureVersionedKeyId(input.versionedKeyId);
  const versionedKeyId = keyUrl.toString().replace(/\/+$/, "");

  const wrappingSecret = mintWrappingSecret();
  let localCapsule: SealedBlobV1;
  let wrapped: AzureWrapKeyResponse;
  try {
    localCapsule = await sealRootUnderWrappingSecret(
      wrappingSecret,
      input.context,
      input.rootKey,
    );
    wrapped = await transport.wrapKey({
      versionedKeyId,
      algorithm: AZURE_WRAP_ALGORITHM,
      plaintext: wrappingSecret,
    });
  } finally {
    zeroBytes(wrappingSecret);
  }
  assertAzureWrapAlgorithm(wrapped.algorithm);
  if (wrapped.versionedKeyId.replace(/\/+$/, "") !== versionedKeyId) {
    throw new ProtectionError(
      "provider_denied",
      "Azure wrap response key id does not match the versioned key.",
    );
  }

  return {
    localCapsule,
    record: {
      kind: "azure-key-vault-keys",
      protectorId: input.context.protectorId,
      versionedKeyId,
      algorithm: AZURE_WRAP_ALGORITHM,
      connectionId: input.connectionId,
      connectionConfigVersion: input.connectionConfigVersion,
      tenantId: input.tenantId,
      wrappedSecretB64: bytesToB64(wrapped.ciphertext),
      localCapsule,
    },
  };
}

async function azureKvUnwrap(
  transport: NonNullable<AzureKeyVaultKeysAdapterOptions["transport"]>,
  input: AzureKeyVaultKeysUnwrapInput,
): Promise<Uint8Array> {
  if (!transport) {
    throw new ProtectionError(
      "unsupported_runtime",
      "Azure Key Vault unwrap requires a native client or injected transport.",
    );
  }
  assertAzureWrapAlgorithm(input.record.algorithm);
  const keyUrl = assertAzureVersionedKeyId(input.record.versionedKeyId);
  const versionedKeyId = keyUrl.toString().replace(/\/+$/, "");

  const unwrapped = await transport.unwrapKey({
    versionedKeyId,
    algorithm: AZURE_WRAP_ALGORITHM,
    ciphertext: b64ToBytes(input.record.wrappedSecretB64),
  });
  assertAzureWrapAlgorithm(unwrapped.algorithm);
  if (unwrapped.versionedKeyId.replace(/\/+$/, "") !== versionedKeyId) {
    throw new ProtectionError(
      "provider_denied",
      "Azure unwrap response key id does not match the versioned key.",
    );
  }
  try {
    assertWrappingSecret(unwrapped.plaintext);
    return await openRootUnderWrappingSecret(
      unwrapped.plaintext,
      input.context,
      input.record.localCapsule,
    );
  } finally {
    zeroBytes(unwrapped.plaintext);
  }
}

export function createAzureKeyVaultKeysProtector(
  options: AzureKeyVaultKeysAdapterOptions = {},
): AzureKeyVaultKeysProtector {
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
      input: Parameters<typeof azureKvWrap>[1],
    ): Promise<Awaited<ReturnType<typeof azureKvWrap>>> {
      if (!transport) {
        throw new ProtectionError(
          "unsupported_runtime",
          "createAzureKeyVaultKeysProtector wrap requires a native client or injected transport.",
        );
      }
      return azureKvWrap(transport, input);
    },

    async unwrap(
      input: Parameters<typeof azureKvUnwrap>[1],
    ): Promise<Uint8Array> {
      if (!transport) {
        throw new ProtectionError(
          "unsupported_runtime",
          "createAzureKeyVaultKeysProtector unwrap requires a native client or injected transport.",
        );
      }
      return azureKvUnwrap(transport, input);
    },

    async dispose(): Promise<void> {
      // Stateless.
    },
  };
}
