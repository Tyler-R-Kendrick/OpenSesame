import { describe, expect, it } from "vitest";
import { ProtectionError } from "../errors.js";
import type { ProtectionContext } from "../types.js";
import {
  azureBearerFromEnv,
  createAzureKeyVaultKeysHttpsTransport,
} from "./azure-key-vault-https.js";
import {
  AZURE_WRAP_ALGORITHM,
  type AzureKeyVaultKeysTransport,
  assertAzureVersionedKeyId,
  assertAzureWrapAlgorithm,
  createAzureKeyVaultKeysProtector,
} from "./azure-key-vault-keys.js";
import {
  assertAllowedCloudEndpoint,
  mintWrappingSecret,
} from "./cloud-wrapping-secret.js";

const CONTEXT: ProtectionContext = {
  vaultId: "vault-1",
  rootKeyId: "root-1",
  rootEpoch: 1,
  protectorId: "prot-az-1",
  purpose: "human-vault-root",
};

const VERSIONED_KEY =
  "https://contoso.vault.azure.net/keys/vault-root/0123456789abcdef0123456789abcdef";

function roundTripTransport(): AzureKeyVaultKeysTransport & {
  seenPlaintextLengths: number[];
} {
  const byCt = new Map<string, Uint8Array>();
  const seenPlaintextLengths: number[] = [];
  const toB64 = (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  return {
    seenPlaintextLengths,
    async wrapKey(request) {
      seenPlaintextLengths.push(request.plaintext.byteLength);
      const ct = crypto.getRandomValues(new Uint8Array(256));
      byCt.set(toB64(ct), new Uint8Array(request.plaintext));
      return {
        versionedKeyId: request.versionedKeyId,
        algorithm: AZURE_WRAP_ALGORITHM,
        ciphertext: ct,
      };
    },
    async unwrapKey(request) {
      const secret = byCt.get(toB64(request.ciphertext));
      if (!secret) {
        throw new ProtectionError("provider_denied", "unknown ciphertext");
      }
      return {
        versionedKeyId: request.versionedKeyId,
        algorithm: AZURE_WRAP_ALGORITHM,
        plaintext: new Uint8Array(secret),
      };
    },
  };
}

describe("azure-key-vault-keys protector (fake transport)", () => {
  it("round-trips root via 32-byte wrapping secret only (KP-31)", async () => {
    const transport = roundTripTransport();
    const protector = createAzureKeyVaultKeysProtector({
      transport,
      authorization: "authorized",
    });
    const rootKey = mintWrappingSecret();
    const { record } = await protector.wrap({
      context: CONTEXT,
      rootKey,
      versionedKeyId: VERSIONED_KEY,
      connectionId: "conn-1",
      connectionConfigVersion: "1",
      tenantId: "tenant-1",
    });
    expect(transport.seenPlaintextLengths).toEqual([32]);
    expect(record.algorithm).toBe("RSA-OAEP-256");
    const opened = await protector.unwrap({ context: CONTEXT, record });
    expect(opened).toEqual(rootKey);
  });

  it("rejects Secrets endpoints (KP-34)", () => {
    expect(() =>
      assertAzureVersionedKeyId(
        "https://contoso.vault.azure.net/secrets/my-secret/abc",
      ),
    ).toThrow(ProtectionError);
  });

  it("rejects unversioned key ids (KP-34)", () => {
    expect(() =>
      assertAzureVersionedKeyId(
        "https://contoso.vault.azure.net/keys/vault-root",
      ),
    ).toThrow(ProtectionError);
  });

  it("rejects RSA1_5 and SHA-1 OAEP (KP-34)", () => {
    expect(() => assertAzureWrapAlgorithm("RSA1_5")).toThrow(ProtectionError);
    expect(() => assertAzureWrapAlgorithm("RSA-OAEP")).toThrow(ProtectionError);
    expect(() => assertAzureWrapAlgorithm("RSA-OAEP-256")).not.toThrow();
  });

  it("blocks SSRF / off-allowlist vault hosts (KP-36)", () => {
    expect(() =>
      assertAllowedCloudEndpoint(
        "https://evil.example/keys/x/y",
        "azure-key-vault",
      ),
    ).toThrow(ProtectionError);
    expect(() =>
      assertAzureVersionedKeyId(
        "https://contoso.vault.azure.net/keys/vault-root/0123456789abcdef0123456789abcdef",
      ),
    ).not.toThrow();
  });

  it("reports requires-native-client without injected transport in browser", () => {
    const protector = createAzureKeyVaultKeysProtector({
      authorization: "authorized",
      assumeBrowser: true,
    });
    expect(protector.capabilities()).toMatchObject({
      runtime: "requires-native-client",
      reasonCode: "cors-blocks-direct-cloud-kms",
    });
  });
});

describe("azure-key-vault-keys live (opt-in)", () => {
  const liveKeyId = process.env.OPENSESAME_TEST_AZURE_KEY_VAULT_KEY_ID;

  it.skipIf(!liveKeyId)(
    "round-trips against disposable Azure Key Vault key",
    async (ctx) => {
      const token = azureBearerFromEnv(process.env);
      if (!token || !liveKeyId) {
        ctx.skip();
        return;
      }
      const transport = createAzureKeyVaultKeysHttpsTransport({
        bearerToken: token,
      });
      const protector = createAzureKeyVaultKeysProtector({
        transport,
        authorization: "authorized",
      });
      const rootKey = mintWrappingSecret();
      const { record } = await protector.wrap({
        context: CONTEXT,
        rootKey,
        versionedKeyId: liveKeyId,
        connectionId: "live-1",
        connectionConfigVersion: "1",
        tenantId:
          process.env.OPENSESAME_TEST_AZURE_TENANT_ID ??
          "00000000-0000-0000-0000-000000000000",
      });
      const opened = await protector.unwrap({ context: CONTEXT, record });
      expect(opened).toEqual(rootKey);
    },
  );

  it("reports blocked when OPENSESAME_TEST_AZURE_KEY_VAULT_KEY_ID is unset", () => {
    if (liveKeyId) return;
    expect({
      status: "blocked" as const,
      reason: "OPENSESAME_TEST_AZURE_KEY_VAULT_KEY_ID unset",
    }).toEqual({
      status: "blocked",
      reason: "OPENSESAME_TEST_AZURE_KEY_VAULT_KEY_ID unset",
    });
  });
});
