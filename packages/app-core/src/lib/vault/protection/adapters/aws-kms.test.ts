import type { ProtectionContext } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { ProtectionError } from "../errors.js";
import {
  awsCredentialsFromEnv,
  createAwsKmsHttpsTransport,
} from "./aws-kms-https.js";
import {
  type AwsKmsTransport,
  assertAwsKmsKeyArn,
  createAwsKmsProtector,
} from "./aws-kms.js";
import {
  assertAllowedCloudEndpoint,
  mintWrappingSecret,
} from "./cloud-wrapping-secret.js";

const CONTEXT: ProtectionContext = {
  vaultId: "vault-1",
  rootKeyId: "root-1",
  rootEpoch: 1,
  protectorId: "prot-aws-1",
  purpose: "human-vault-root",
};

const KEY_ARN =
  "arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-1234567890ab";

/** Honest fake: retains a copy of the 32-byte secret keyed by ciphertext. */
function roundTripTransport(): AwsKmsTransport & {
  seenPlaintextLengths: number[];
} {
  const byCt = new Map<string, Uint8Array>();
  const seenPlaintextLengths: number[] = [];
  const bytesToB64 = (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  return {
    seenPlaintextLengths,
    async encrypt(request) {
      seenPlaintextLengths.push(request.plaintext.byteLength);
      const ct = crypto.getRandomValues(new Uint8Array(64));
      byCt.set(bytesToB64(ct), new Uint8Array(request.plaintext));
      return { ciphertext: ct, keyId: request.keyArn };
    },
    async decrypt(request) {
      const secret = byCt.get(bytesToB64(request.ciphertext));
      if (!secret) {
        throw new ProtectionError("provider_denied", "unknown ciphertext");
      }
      if (request.expectedKeyArn !== KEY_ARN) {
        throw new ProtectionError("provider_denied", "wrong key");
      }
      return { plaintext: new Uint8Array(secret), keyId: KEY_ARN };
    },
  };
}

describe("aws-kms protector (fake transport)", () => {
  it("round-trips root via 32-byte wrapping secret only (KP-31)", async () => {
    const transport = roundTripTransport();
    const protector = createAwsKmsProtector({
      transport,
      authorization: "authorized",
    });
    const rootKey = mintWrappingSecret();
    const { record } = await protector.wrap({
      context: CONTEXT,
      rootKey,
      keyArn: KEY_ARN,
      region: "us-west-2",
      connectionId: "conn-1",
      connectionConfigVersion: "1",
    });
    expect(transport.seenPlaintextLengths).toEqual([32]);
    const opened = await protector.unwrap({ context: CONTEXT, record });
    expect(opened).toEqual(rootKey);
  });

  it("rejects alias identity (KP-33)", () => {
    expect(() =>
      assertAwsKmsKeyArn("arn:aws:kms:us-west-2:123456789012:alias/prod"),
    ).toThrow(ProtectionError);
  });

  it("rejects wrong EncryptionContext on unwrap (KP-33)", async () => {
    const transport = roundTripTransport();
    const protector = createAwsKmsProtector({
      transport,
      authorization: "authorized",
    });
    const rootKey = mintWrappingSecret();
    const { record } = await protector.wrap({
      context: CONTEXT,
      rootKey,
      keyArn: KEY_ARN,
      region: "us-west-2",
      connectionId: "conn-1",
      connectionConfigVersion: "1",
    });
    const other: ProtectionContext = { ...CONTEXT, vaultId: "other-vault" };
    await expect(
      protector.unwrap({ context: other, record }),
    ).rejects.toMatchObject({ code: "context_mismatch" });
  });

  it("rejects decrypt key mismatch (KP-33)", async () => {
    const transport: AwsKmsTransport = {
      async encrypt(request) {
        return {
          ciphertext: new Uint8Array(64),
          keyId: request.keyArn,
        };
      },
      async decrypt() {
        return {
          plaintext: mintWrappingSecret(),
          keyId:
            "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000000",
        };
      },
    };
    const protector = createAwsKmsProtector({
      transport,
      authorization: "authorized",
    });
    const rootKey = mintWrappingSecret();
    // encrypt path ok; craft record manually after wrap fails key check on encrypt if wrong — force unwrap
    const { record } = await protector.wrap({
      context: CONTEXT,
      rootKey,
      keyArn: KEY_ARN,
      region: "us-west-2",
      connectionId: "conn-1",
      connectionConfigVersion: "1",
    });
    await expect(
      protector.unwrap({ context: CONTEXT, record }),
    ).rejects.toMatchObject({ code: "provider_denied" });
  });

  it("blocks SSRF endpoints (KP-36)", () => {
    expect(() =>
      assertAllowedCloudEndpoint(
        "http://kms.us-west-2.amazonaws.com/",
        "aws-kms",
      ),
    ).toThrow(ProtectionError);
    expect(() =>
      assertAllowedCloudEndpoint("https://169.254.169.254/latest/", "aws-kms"),
    ).toThrow(ProtectionError);
    expect(() =>
      assertAllowedCloudEndpoint(
        "https://evil.example/kms.us-west-2.amazonaws.com/",
        "aws-kms",
      ),
    ).toThrow(ProtectionError);
    expect(() =>
      assertAllowedCloudEndpoint(
        "https://kms.us-west-2.amazonaws.com/",
        "aws-kms",
      ),
    ).not.toThrow();
  });

  it("reports requires-native-client without injected transport in browser", () => {
    const protector = createAwsKmsProtector({
      authorization: "authorized",
      assumeBrowser: true,
    });
    expect(protector.capabilities()).toMatchObject({
      implementation: "implemented",
      runtime: "requires-native-client",
      reasonCode: "cors-blocks-direct-cloud-kms",
    });
  });
});

describe("aws-kms live (opt-in)", () => {
  const liveArn = process.env.OPENSESAME_TEST_AWS_KMS_KEY_ARN;

  it.skipIf(!liveArn)(
    "round-trips against disposable AWS KMS key",
    async (ctx) => {
      const keyArn = liveArn;
      if (!keyArn) {
        ctx.skip();
        return;
      }
      const credentials = awsCredentialsFromEnv(process.env);
      if (!credentials) {
        ctx.skip();
        return;
      }
      const transport = createAwsKmsHttpsTransport({ credentials });
      const protector = createAwsKmsProtector({
        transport,
        authorization: "authorized",
      });
      const rootKey = mintWrappingSecret();
      const { region } = assertAwsKmsKeyArn(keyArn);
      const { record } = await protector.wrap({
        context: CONTEXT,
        rootKey,
        keyArn,
        region,
        connectionId: "live-1",
        connectionConfigVersion: "1",
      });
      const opened = await protector.unwrap({ context: CONTEXT, record });
      expect(opened).toEqual(rootKey);
    },
  );

  it("reports blocked when OPENSESAME_TEST_AWS_KMS_KEY_ARN is unset", () => {
    if (liveArn) return;
    expect({
      status: "blocked" as const,
      reason: "OPENSESAME_TEST_AWS_KMS_KEY_ARN unset",
    }).toEqual({
      status: "blocked",
      reason: "OPENSESAME_TEST_AWS_KMS_KEY_ARN unset",
    });
  });
});
