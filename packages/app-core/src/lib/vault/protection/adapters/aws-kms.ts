/**
 * AWS KMS root protector (C05/C10).
 * Full key ARN identity, EncryptionContext from ProtectionContext, expected key
 * on decrypt. Injectible transport for unit tests (KP-31/KP-33/KP-36).
 */

import { ProtectionError } from "../errors.js";
import type {
  AwsKmsProtectorRecord,
  ProtectionContext,
  ProtectorAvailability,
  SealedBlobV1,
} from "../types.js";
import {
  type CloudProtectionBinding,
  assertRootKey,
  assertWrappingSecret,
  awsKmsEndpointForRegion,
  b64ToBytes,
  bindingEquals,
  bytesToB64,
  cloudBrowserAvailability,
  encryptionContextFromProtection,
  mintWrappingSecret,
  openRootUnderWrappingSecret,
  sealRootUnderWrappingSecret,
  stringMapToBinding,
  zeroBytes,
} from "./cloud-wrapping-secret.js";

const KEY_ARN_RE =
  /^arn:aws(?:-[a-z]+)?:kms:([a-z0-9-]+):\d{12}:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AwsKmsKeyIdentity = {
  keyArn: string;
  region: string;
};

export type AwsKmsEncryptRequest = {
  keyArn: string;
  plaintext: Uint8Array;
  encryptionContext: CloudProtectionBinding;
};

export type AwsKmsEncryptResponse = {
  ciphertext: Uint8Array;
  /** Provider-returned key id (ARN preferred). */
  keyId: string;
};

export type AwsKmsDecryptRequest = {
  ciphertext: Uint8Array;
  encryptionContext: CloudProtectionBinding;
  expectedKeyArn: string;
};

export type AwsKmsDecryptResponse = {
  plaintext: Uint8Array;
  keyId: string;
};

/** Injectible HTTP/KMS boundary — unit tests fake this; no secrets in logs. */
export type AwsKmsTransport = {
  encrypt(request: AwsKmsEncryptRequest): Promise<AwsKmsEncryptResponse>;
  decrypt(request: AwsKmsDecryptRequest): Promise<AwsKmsDecryptResponse>;
};

export type AwsKmsAdapterOptions = {
  transport?: AwsKmsTransport;
  authorization?: ProtectorAvailability["authorization"];
  /** Test seam for CORS capability reporting. */
  assumeBrowser?: boolean;
};

export type AwsKmsWrapInput = {
  context: ProtectionContext;
  rootKey: Uint8Array;
  keyArn: string;
  region: string;
  connectionId: string;
  connectionConfigVersion: string;
};

export type AwsKmsWrapResult = {
  record: Omit<AwsKmsProtectorRecord, "proofStatus" | "lastEvidence">;
  localCapsule: SealedBlobV1;
};

export type AwsKmsUnwrapInput = {
  context: ProtectionContext;
  record: Pick<
    AwsKmsProtectorRecord,
    | "keyArn"
    | "region"
    | "wrappedSecretB64"
    | "localCapsule"
    | "encryptionContext"
  >;
};

export type AwsKmsProtector = {
  capabilities(): ProtectorAvailability;
  wrap(input: AwsKmsWrapInput): Promise<AwsKmsWrapResult>;
  unwrap(input: AwsKmsUnwrapInput): Promise<Uint8Array>;
  dispose(): Promise<void>;
};

export function assertAwsKmsKeyArn(keyArn: string): AwsKmsKeyIdentity {
  if (keyArn.includes(":alias/") || keyArn.startsWith("alias/")) {
    throw new ProtectionError(
      "malformed_encoding",
      "AWS KMS protector requires a full key ARN, not an alias.",
    );
  }
  const match = KEY_ARN_RE.exec(keyArn);
  if (!match) {
    throw new ProtectionError(
      "malformed_encoding",
      "AWS KMS key identity must be a full key ARN.",
    );
  }
  const region = match[1];
  if (region === undefined) {
    throw new ProtectionError(
      "malformed_encoding",
      "AWS KMS key ARN region is missing.",
    );
  }
  return { keyArn, region };
}

function assertKeyMatchesExpected(
  returnedKeyId: string,
  expectedArn: string,
): void {
  if (returnedKeyId === expectedArn) return;
  const expectedId = expectedArn.split("/").pop();
  if (
    expectedId !== undefined &&
    (returnedKeyId === expectedId ||
      returnedKeyId.endsWith(`:${expectedId}`) ||
      returnedKeyId.endsWith(`/key/${expectedId}`))
  ) {
    return;
  }
  throw new ProtectionError(
    "provider_denied",
    "AWS KMS decrypt returned a key that does not match the expected ARN.",
  );
}

async function awsKmsWrap(
  transport: NonNullable<AwsKmsAdapterOptions["transport"]>,
  input: AwsKmsWrapInput,
): Promise<AwsKmsWrapResult> {
  assertRootKey(input.rootKey);
  const { keyArn, region } = assertAwsKmsKeyArn(input.keyArn);
  if (region !== input.region) {
    throw new ProtectionError(
      "context_mismatch",
      "AWS KMS key ARN region does not match configured region.",
    );
  }
  awsKmsEndpointForRegion(region);

  const encryptionContext = encryptionContextFromProtection(input.context);
  const wrappingSecret = mintWrappingSecret();
  let localCapsule: SealedBlobV1;
  let wrapped: AwsKmsEncryptResponse;
  try {
    localCapsule = await sealRootUnderWrappingSecret(
      wrappingSecret,
      input.context,
      input.rootKey,
    );
    wrapped = await transport.encrypt({
      keyArn,
      plaintext: wrappingSecret,
      encryptionContext,
    });
  } finally {
    zeroBytes(wrappingSecret);
  }
  assertKeyMatchesExpected(wrapped.keyId, keyArn);
  return {
    localCapsule,
    record: {
      kind: "aws-kms",
      protectorId: input.context.protectorId,
      keyArn,
      region,
      connectionId: input.connectionId,
      connectionConfigVersion: input.connectionConfigVersion,
      wrappedSecretB64: bytesToB64(wrapped.ciphertext),
      localCapsule,
      encryptionContext: {
        domain: encryptionContext.domain,
        vaultId: encryptionContext.vaultId,
        rootKeyId: encryptionContext.rootKeyId,
        rootEpoch: encryptionContext.rootEpoch,
        protectorId: encryptionContext.protectorId,
        purpose: encryptionContext.purpose,
      },
    },
  };
}

async function awsKmsUnwrap(
  transport: NonNullable<AwsKmsAdapterOptions["transport"]>,
  input: AwsKmsUnwrapInput,
): Promise<Uint8Array> {
  const { keyArn, region } = assertAwsKmsKeyArn(input.record.keyArn);
  if (region !== input.record.region) {
    throw new ProtectionError(
      "context_mismatch",
      "AWS KMS key ARN region does not match record region.",
    );
  }
  awsKmsEndpointForRegion(region);

  const expectedContext = encryptionContextFromProtection(input.context);
  const storedContext = stringMapToBinding(input.record.encryptionContext);
  if (!bindingEquals(expectedContext, storedContext)) {
    throw new ProtectionError(
      "context_mismatch",
      "AWS KMS EncryptionContext does not match protection context.",
    );
  }

  const decrypted = await transport.decrypt({
    ciphertext: b64ToBytes(input.record.wrappedSecretB64),
    encryptionContext: expectedContext,
    expectedKeyArn: keyArn,
  });
  assertKeyMatchesExpected(decrypted.keyId, keyArn);
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

export function createAwsKmsProtector(
  options: AwsKmsAdapterOptions = {},
): AwsKmsProtector {
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

    async wrap(input: AwsKmsWrapInput): Promise<AwsKmsWrapResult> {
      if (!transport) {
        throw new ProtectionError(
          "unsupported_runtime",
          "AWS KMS wrap requires a native client or injected transport.",
        );
      }
      return awsKmsWrap(transport, input);
    },

    async unwrap(input: AwsKmsUnwrapInput): Promise<Uint8Array> {
      if (!transport) {
        throw new ProtectionError(
          "unsupported_runtime",
          "AWS KMS unwrap requires a native client or injected transport.",
        );
      }
      return awsKmsUnwrap(transport, input);
    },

    async dispose(): Promise<void> {
      // Stateless adapter — secrets wiped at wrap/unwrap boundaries.
    },
  };
}
