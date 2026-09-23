/**
 * Live AWS KMS HTTPS transport (SigV4). Used by native/Node live harnesses;
 * browser CORS usually blocks direct calls — callers must handle that.
 */

import { ProtectionError } from "../errors.js";
import {
  type AwsKmsDecryptRequest,
  type AwsKmsDecryptResponse,
  type AwsKmsEncryptRequest,
  type AwsKmsEncryptResponse,
  type AwsKmsTransport,
  assertAwsKmsKeyArn,
} from "./aws-kms.js";
import { type AwsSigV4Credentials, signAwsKmsJsonPost } from "./aws-sigv4.js";
import {
  assertAllowedCloudEndpoint,
  b64ToBytes,
  bytesToB64,
} from "./cloud-wrapping-secret.js";

export type AwsProcessEnvMap = {
  readonly [key: string]: string | undefined;
};

export type AwsKmsHttpsOptions = {
  credentials: AwsSigV4Credentials;
  fetchImpl?: typeof fetch;
};

function bytesFromB64Field(value: string): Uint8Array {
  // AWS JSON APIs return blob fields as base64.
  return b64ToBytes(value);
}

async function awsKmsHttpsEncrypt(
  fetchImpl: typeof fetch,
  credentials: AwsKmsHttpsOptions["credentials"],
  request: AwsKmsEncryptRequest,
): Promise<AwsKmsEncryptResponse> {
  const { region } = assertAwsKmsKeyArn(request.keyArn);
  const endpoint = `https://kms.${region}.amazonaws.com/`;
  assertAllowedCloudEndpoint(endpoint, "aws-kms");
  const signed = await signAwsKmsJsonPost({
    region,
    target: "TrentService.Encrypt",
    body: {
      KeyId: request.keyArn,
      Plaintext: bytesToB64(request.plaintext),
      EncryptionContext: request.encryptionContext,
    },
    credentials,
  });
  let response: Response;
  try {
    response = await fetchImpl(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    });
  } catch {
    throw new ProtectionError(
      "unavailable",
      "AWS KMS HTTPS encrypt failed (network or CORS).",
    );
  }
  if (!response.ok) {
    throw new ProtectionError(
      "provider_denied",
      `AWS KMS encrypt denied (${response.status}).`,
    );
  }
  const json: { CiphertextBlob?: string; KeyId?: string } =
    await response.json();
  if (!json.CiphertextBlob || !json.KeyId) {
    throw new ProtectionError(
      "provider_denied",
      "AWS KMS encrypt response missing ciphertext.",
    );
  }
  return {
    ciphertext: bytesFromB64Field(json.CiphertextBlob),
    keyId: json.KeyId,
  };
}

async function awsKmsHttpsDecrypt(
  fetchImpl: typeof fetch,
  credentials: AwsKmsHttpsOptions["credentials"],
  request: AwsKmsDecryptRequest,
): Promise<AwsKmsDecryptResponse> {
  const { region } = assertAwsKmsKeyArn(request.expectedKeyArn);
  const endpoint = `https://kms.${region}.amazonaws.com/`;
  assertAllowedCloudEndpoint(endpoint, "aws-kms");
  const signed = await signAwsKmsJsonPost({
    region,
    target: "TrentService.Decrypt",
    body: {
      CiphertextBlob: bytesToB64(request.ciphertext),
      EncryptionContext: request.encryptionContext,
    },
    credentials,
  });
  let response: Response;
  try {
    response = await fetchImpl(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    });
  } catch {
    throw new ProtectionError(
      "unavailable",
      "AWS KMS HTTPS decrypt failed (network or CORS).",
    );
  }
  if (!response.ok) {
    throw new ProtectionError(
      "provider_denied",
      `AWS KMS decrypt denied (${response.status}).`,
    );
  }
  const json: { Plaintext?: string; KeyId?: string } = await response.json();
  if (!json.Plaintext || !json.KeyId) {
    throw new ProtectionError(
      "provider_denied",
      "AWS KMS decrypt response missing plaintext.",
    );
  }
  const expectedSuffix = request.expectedKeyArn.split("/").pop() ?? "";
  if (
    json.KeyId !== request.expectedKeyArn &&
    expectedSuffix.length > 0 &&
    !json.KeyId.includes(expectedSuffix)
  ) {
    throw new ProtectionError(
      "provider_denied",
      "AWS KMS decrypt returned an unexpected key id.",
    );
  }
  return {
    plaintext: bytesFromB64Field(json.Plaintext),
    keyId: json.KeyId,
  };
}

export function createAwsKmsHttpsTransport(
  options: AwsKmsHttpsOptions,
): AwsKmsTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    encrypt: (request) =>
      awsKmsHttpsEncrypt(fetchImpl, options.credentials, request),
    decrypt: (request) =>
      awsKmsHttpsDecrypt(fetchImpl, options.credentials, request),
  };
}

export function awsCredentialsFromEnv(
  env: AwsProcessEnvMap,
): AwsSigV4Credentials | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = env.AWS_SESSION_TOKEN?.trim();
  if (sessionToken) {
    return { accessKeyId, secretAccessKey, sessionToken };
  }
  return { accessKeyId, secretAccessKey };
}
