/**
 * Live GCP Cloud KMS HTTPS transport (Bearer). Browser CORS may block;
 * native/Node live harnesses use this path.
 */

import { ProtectionError } from "../errors.js";
import {
  assertAllowedCloudEndpoint,
  b64ToBytes,
  bytesToB64,
} from "./cloud-wrapping-secret.js";
import {
  type GcpKmsDecryptRequest,
  type GcpKmsDecryptResponse,
  type GcpKmsEncryptRequest,
  type GcpKmsEncryptResponse,
  type GcpKmsTransport,
  assertGcpCryptoKeyName,
  assertGcpKeyVersionName,
  crc32cDecimalString,
} from "./gcp-kms.js";

export type GcpProcessEnvMap = {
  readonly [key: string]: string | undefined;
};

export type GcpKmsHttpsOptions = {
  bearerToken: string;
  fetchImpl?: typeof fetch;
};

async function gcpKmsHttpsEncrypt(
  fetchImpl: typeof fetch,
  auth: string,
  request: GcpKmsEncryptRequest,
): Promise<GcpKmsEncryptResponse> {
  assertGcpCryptoKeyName(request.keyName);
  const endpoint = `https://cloudkms.googleapis.com/v1/${request.keyName}:encrypt`;
  assertAllowedCloudEndpoint(endpoint, "gcp-kms");
  const plaintextB64 = bytesToB64(request.plaintext);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        plaintext: plaintextB64,
        plaintextCrc32c: { value: crc32cDecimalString(request.plaintext) },
        additionalAuthenticatedData: request.aad
          ? bytesToB64(request.aad)
          : undefined,
      }),
    });
  } catch {
    throw new ProtectionError(
      "unavailable",
      "GCP KMS encrypt failed (network or CORS).",
    );
  }
  if (!response.ok) {
    throw new ProtectionError(
      "provider_denied",
      `GCP KMS encrypt denied (${response.status}).`,
    );
  }
  const json: {
    ciphertext?: string;
    name?: string;
    verifiedPlaintextCrc32c?: boolean;
    ciphertextCrc32c?: { value?: string };
  } = await response.json();
  if (!json.ciphertext || !json.name) {
    throw new ProtectionError(
      "provider_denied",
      "GCP KMS encrypt response missing ciphertext.",
    );
  }
  const ct = b64ToBytes(json.ciphertext);
  if (!json.ciphertextCrc32c?.value) {
    throw new ProtectionError(
      "provider_denied",
      "GCP KMS encrypt response missing ciphertext integrity value.",
    );
  }
  return {
    ciphertext: ct,
    keyVersionName: json.name,
    ciphertextCrc32c: json.ciphertextCrc32c.value,
    ...(json.verifiedPlaintextCrc32c !== undefined
      ? { verifiedPlaintextCrc32c: json.verifiedPlaintextCrc32c }
      : undefined),
  };
}

async function gcpKmsHttpsDecrypt(
  fetchImpl: typeof fetch,
  auth: string,
  request: GcpKmsDecryptRequest,
): Promise<GcpKmsDecryptResponse> {
  assertGcpCryptoKeyName(request.keyName);
  const pinned = request.expectedKeyVersionName;
  if (pinned !== undefined) {
    assertGcpKeyVersionName(pinned);
    if (!pinned.startsWith(`${request.keyName}/cryptoKeyVersions/`))
      throw new ProtectionError(
        "malformed_encoding",
        "GCP KMS key version does not belong to the configured key.",
      );
  }
  const resource = pinned ?? request.keyName;
  const endpoint = `https://cloudkms.googleapis.com/v1/${resource}:decrypt`;
  assertAllowedCloudEndpoint(endpoint, "gcp-kms");
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ciphertext: bytesToB64(request.ciphertext),
        additionalAuthenticatedData: request.aad
          ? bytesToB64(request.aad)
          : undefined,
      }),
    });
  } catch {
    throw new ProtectionError(
      "unavailable",
      "GCP KMS decrypt failed (network or CORS).",
    );
  }
  if (!response.ok) {
    throw new ProtectionError(
      "provider_denied",
      `GCP KMS decrypt denied (${response.status}).`,
    );
  }
  const json: {
    plaintext?: string;
    plaintextCrc32c?: { value?: string };
    verifiedCiphertextCrc32c?: boolean;
    verifiedAdditionalAuthenticatedDataCrc32c?: boolean;
  } = await response.json();
  if (!json.plaintext) {
    throw new ProtectionError(
      "provider_denied",
      "GCP KMS decrypt response missing plaintext.",
    );
  }
  const plaintext = b64ToBytes(json.plaintext);
  if (!json.plaintextCrc32c?.value) {
    throw new ProtectionError(
      "provider_denied",
      "GCP KMS decrypt response missing plaintext integrity value.",
    );
  }
  return {
    plaintext,
    plaintextCrc32c: json.plaintextCrc32c.value,
    ...(json.verifiedCiphertextCrc32c !== undefined
      ? { verifiedCiphertextCrc32c: json.verifiedCiphertextCrc32c }
      : undefined),
    ...(json.verifiedAdditionalAuthenticatedDataCrc32c !== undefined
      ? {
          verifiedAdditionalAuthenticatedDataCrc32c:
            json.verifiedAdditionalAuthenticatedDataCrc32c,
        }
      : undefined),
  };
}

export function createGcpKmsHttpsTransport(
  options: GcpKmsHttpsOptions,
): GcpKmsTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const auth = `Bearer ${options.bearerToken}`;
  return {
    encrypt: (request) => gcpKmsHttpsEncrypt(fetchImpl, auth, request),
    decrypt: (request) => gcpKmsHttpsDecrypt(fetchImpl, auth, request),
  };
}

export function gcpBearerFromEnv(env: GcpProcessEnvMap): string | null {
  const token =
    env.OPENSESAME_TEST_GCP_ACCESS_TOKEN?.trim() ||
    env.OPENSESAME_TEST_GCP_BEARER?.trim() ||
    env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim() ||
    null;
  return token && token.length > 0 ? token : null;
}
