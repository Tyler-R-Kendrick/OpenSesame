import type { ProtectionContext } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { ProtectionError } from "../errors.js";
import {
  assertAllowedCloudEndpoint,
  mintWrappingSecret,
} from "./cloud-wrapping-secret.js";
import {
  createGcpKmsHttpsTransport,
  gcpBearerFromEnv,
} from "./gcp-kms-https.js";
import {
  type GcpKmsTransport,
  assertGcpCryptoKeyName,
  crc32c,
  crc32cDecimalString,
  createGcpKmsProtector,
} from "./gcp-kms.js";

const CONTEXT: ProtectionContext = {
  vaultId: "vault-1",
  rootKeyId: "root-1",
  rootEpoch: 1,
  protectorId: "prot-gcp-1",
  purpose: "human-vault-root",
};

const KEY_NAME =
  "projects/demo/locations/us-central1/keyRings/ring/cryptoKeys/vault-root";
const KEY_VERSION = `${KEY_NAME}/cryptoKeyVersions/1`;

type RoundTripTransportOpts = {
  failVerifiedPlaintext?: boolean;
  badCiphertextCrc?: boolean;
};

function roundTripTransport(
  opts?: RoundTripTransportOpts,
): GcpKmsTransport & { seenPlaintextLengths: number[] } {
  const byCt = new Map<string, Uint8Array>();
  const seenPlaintextLengths: number[] = [];
  const toB64 = (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  return {
    seenPlaintextLengths,
    async encrypt(request) {
      seenPlaintextLengths.push(request.plaintext.byteLength);
      const ct = crypto.getRandomValues(new Uint8Array(64));
      byCt.set(toB64(ct), new Uint8Array(request.plaintext));
      return {
        ciphertext: ct,
        keyVersionName: KEY_VERSION,
        ciphertextCrc32c: opts?.badCiphertextCrc
          ? "0"
          : crc32cDecimalString(ct),
        verifiedPlaintextCrc32c: !opts?.failVerifiedPlaintext,
        verifiedAdditionalAuthenticatedDataCrc32c: true,
      };
    },
    async decrypt(request) {
      const secret = byCt.get(toB64(request.ciphertext));
      if (!secret) {
        throw new ProtectionError("provider_denied", "unknown ciphertext");
      }
      return {
        plaintext: new Uint8Array(secret),
        plaintextCrc32c: crc32cDecimalString(secret),
        verifiedCiphertextCrc32c: true,
        verifiedAdditionalAuthenticatedDataCrc32c: true,
      };
    },
  };
}

describe("gcp-kms protector (fake transport)", () => {
  it("round-trips root via 32-byte wrapping secret only (KP-31)", async () => {
    const transport = roundTripTransport();
    const protector = createGcpKmsProtector({
      transport,
      authorization: "authorized",
    });
    const rootKey = mintWrappingSecret();
    const { record } = await protector.wrap({
      context: CONTEXT,
      rootKey,
      keyName: KEY_NAME,
      connectionId: "conn-1",
      connectionConfigVersion: "1",
    });
    expect(transport.seenPlaintextLengths).toEqual([32]);
    expect(record.keyVersionName).toBe(KEY_VERSION);
    const opened = await protector.unwrap({ context: CONTEXT, record });
    expect(opened).toEqual(rootKey);
  });

  it("rejects malformed resource names (KP-35)", () => {
    expect(() => assertGcpCryptoKeyName("projects/x")).toThrow(ProtectionError);
    expect(() => assertGcpCryptoKeyName(KEY_NAME)).not.toThrow();
  });

  it("rejects failed CRC / integrity flags (KP-35)", async () => {
    const badFlag = createGcpKmsProtector({
      transport: roundTripTransport({ failVerifiedPlaintext: true }),
      authorization: "authorized",
    });
    await expect(
      badFlag.wrap({
        context: CONTEXT,
        rootKey: mintWrappingSecret(),
        keyName: KEY_NAME,
        connectionId: "conn-1",
        connectionConfigVersion: "1",
      }),
    ).rejects.toMatchObject({ code: "provider_denied" });

    const badCrc = createGcpKmsProtector({
      transport: roundTripTransport({ badCiphertextCrc: true }),
      authorization: "authorized",
    });
    await expect(
      badCrc.wrap({
        context: CONTEXT,
        rootKey: mintWrappingSecret(),
        keyName: KEY_NAME,
        connectionId: "conn-1",
        connectionConfigVersion: "1",
      }),
    ).rejects.toMatchObject({ code: "provider_denied" });
  });

  it("rejects AAD / context mismatch (KP-35)", async () => {
    const transport = roundTripTransport();
    const protector = createGcpKmsProtector({
      transport,
      authorization: "authorized",
    });
    const rootKey = mintWrappingSecret();
    const { record } = await protector.wrap({
      context: CONTEXT,
      rootKey,
      keyName: KEY_NAME,
      connectionId: "conn-1",
      connectionConfigVersion: "1",
    });
    const other: ProtectionContext = { ...CONTEXT, purpose: "workload-root" };
    await expect(
      protector.unwrap({ context: other, record }),
    ).rejects.toMatchObject({ code: "context_mismatch" });
  });

  it("blocks SSRF endpoints (KP-36)", () => {
    expect(() =>
      assertAllowedCloudEndpoint(
        "https://metadata.google.internal/computeMetadata/v1/",
        "gcp-kms",
      ),
    ).toThrow(ProtectionError);
    expect(() =>
      assertAllowedCloudEndpoint(
        "https://cloudkms.googleapis.com/v1/",
        "gcp-kms",
      ),
    ).not.toThrow();
  });

  it("computes stable CRC32C", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
  });

  it("reports requires-native-client without injected transport in browser", () => {
    const protector = createGcpKmsProtector({
      authorization: "authorized",
      assumeBrowser: true,
    });
    expect(protector.capabilities()).toMatchObject({
      runtime: "requires-native-client",
    });
  });
});

describe("gcp-kms live (opt-in)", () => {
  const liveKey = process.env.OPENSESAME_TEST_GCP_KMS_KEY_NAME;

  it.skipIf(!liveKey)(
    "round-trips against disposable GCP KMS key",
    async (ctx) => {
      const token = gcpBearerFromEnv(process.env);
      if (!token || !liveKey) {
        ctx.skip();
        return;
      }
      const transport = createGcpKmsHttpsTransport({ bearerToken: token });
      const protector = createGcpKmsProtector({
        transport,
        authorization: "authorized",
      });
      const rootKey = mintWrappingSecret();
      const { record } = await protector.wrap({
        context: CONTEXT,
        rootKey,
        keyName: liveKey,
        connectionId: "live-1",
        connectionConfigVersion: "1",
      });
      const opened = await protector.unwrap({ context: CONTEXT, record });
      expect(opened).toEqual(rootKey);
    },
  );

  it("reports blocked when OPENSESAME_TEST_GCP_KMS_KEY_NAME is unset", () => {
    if (liveKey) return;
    expect({
      status: "blocked" as const,
      reason: "OPENSESAME_TEST_GCP_KMS_KEY_NAME unset",
    }).toEqual({
      status: "blocked",
      reason: "OPENSESAME_TEST_GCP_KMS_KEY_NAME unset",
    });
  });
});
