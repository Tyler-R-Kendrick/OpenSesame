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
  return {
    ciphertext: ct,
    keyVersionName: json.name,
    ciphertextCrc32c: json.ciphertextCrc32c?.value ?? crc32cDecimalString(ct),
    verifiedPlaintextCrc32c: json.verifiedPlaintextCrc32c === true,
  };
}

async function gcpKmsHttpsDecrypt(
  fetchImpl: typeof fetch,
  auth: string,
  request: GcpKmsDecryptRequest,
): Promise<GcpKmsDecryptResponse> {
  assertGcpCryptoKeyName(request.keyName);
  const endpoint = `https://cloudkms.googleapis.com/v1/${request.keyName}:decrypt`;
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
  const json: { plaintext?: string } = await response.json();
  if (!json.plaintext) {
    throw new ProtectionError(
      "provider_denied",
      "GCP KMS decrypt response missing plaintext.",
    );
  }
  return { plaintext: b64ToBytes(json.plaintext) };
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
