/**
 * Live Azure Key Vault Keys HTTPS transport (Bearer). Browser CORS may block;
 * native/Node live harnesses use this path.
 */

import { ProtectionError } from "../errors.js";
import {
  AZURE_WRAP_ALGORITHM,
  type AzureKeyVaultKeysTransport,
  type AzureUnwrapKeyRequest,
  type AzureUnwrapKeyResponse,
  type AzureWrapKeyRequest,
  type AzureWrapKeyResponse,
  assertAzureVersionedKeyId,
} from "./azure-key-vault-keys.js";
import { b64ToBytes, bytesToB64 } from "./cloud-wrapping-secret.js";

export type AzureProcessEnvMap = {
  readonly [key: string]: string | undefined;
};

export type AzureKeyVaultHttpsOptions = {
  bearerToken: string;
  fetchImpl?: typeof fetch;
  apiVersion?: string;
};

export function createAzureKeyVaultKeysHttpsTransport(
  options: AzureKeyVaultHttpsOptions,
): AzureKeyVaultKeysTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiVersion = options.apiVersion ?? "7.4";
  const auth = `Bearer ${options.bearerToken}`;

  return {
    async wrapKey(request: AzureWrapKeyRequest): Promise<AzureWrapKeyResponse> {
      const url = assertAzureVersionedKeyId(request.versionedKeyId);
      const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
      const endpoint = `${base}/wrapkey?api-version=${apiVersion}`;
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: auth,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            alg: request.algorithm,
            value: bytesToB64(request.plaintext),
          }),
        });
      } catch {
        throw new ProtectionError(
          "unavailable",
          "Azure Key Vault wrap failed (network or CORS).",
        );
      }
      if (!response.ok) {
        throw new ProtectionError(
          "provider_denied",
          `Azure Key Vault wrap denied (${response.status}).`,
        );
      }
      const json: { value?: string } = await response.json();
      if (!json.value) {
        throw new ProtectionError(
          "provider_denied",
          "Azure Key Vault wrap response missing value.",
        );
      }
      return {
        versionedKeyId: request.versionedKeyId,
        algorithm: AZURE_WRAP_ALGORITHM,
        ciphertext: b64ToBytes(json.value),
      };
    },

    async unwrapKey(
      request: AzureUnwrapKeyRequest,
    ): Promise<AzureUnwrapKeyResponse> {
      const url = assertAzureVersionedKeyId(request.versionedKeyId);
      const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
      const endpoint = `${base}/unwrapkey?api-version=${apiVersion}`;
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: auth,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            alg: request.algorithm,
            value: bytesToB64(request.ciphertext),
          }),
        });
      } catch {
        throw new ProtectionError(
          "unavailable",
          "Azure Key Vault unwrap failed (network or CORS).",
        );
      }
      if (!response.ok) {
        throw new ProtectionError(
          "provider_denied",
          `Azure Key Vault unwrap denied (${response.status}).`,
        );
      }
      const json: { value?: string } = await response.json();
      if (!json.value) {
        throw new ProtectionError(
          "provider_denied",
          "Azure Key Vault unwrap response missing value.",
        );
      }
      return {
        versionedKeyId: request.versionedKeyId,
        algorithm: AZURE_WRAP_ALGORITHM,
        plaintext: b64ToBytes(json.value),
      };
    },
  };
}

export function azureBearerFromEnv(env: AzureProcessEnvMap): string | null {
  const token =
    env.OPENSESAME_TEST_AZURE_ACCESS_TOKEN?.trim() ||
    env.OPENSESAME_TEST_AZURE_BEARER?.trim() ||
    env.AZURE_ACCESS_TOKEN?.trim() ||
    null;
  return token && token.length > 0 ? token : null;
}
