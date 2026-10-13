import type { RootProtectionManifest } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { canonicalizeToString } from "./canonicalize.js";
import {
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "./manifest-auth.js";

function manifest(
  encryptionContext: Record<string, string>,
): Omit<RootProtectionManifest, "authB64"> {
  return {
    schemaVersion: 1,
    vaultId: "canonical-map-fixture",
    rootKeyId: "canonical-map-root",
    rootEpoch: 0,
    revision: 1,
    purpose: "human-vault-root",
    legacyGates: {
      totpEnrolled: false,
      emailEnrolled: false,
      smsEnrolled: false,
      recoveryCodesEnrolled: false,
    },
    records: [
      {
        kind: "aws-kms",
        protectorId: "fixture-kms",
        proofStatus: "verified",
        keyArn: "arn:aws:kms:us-east-1:000000000000:key/fixture",
        region: "us-east-1",
        connectionId: "fixture-connection",
        connectionConfigVersion: "1",
        wrappedSecretB64: btoa("w".repeat(32)),
        localCapsule: {
          ivB64: btoa("i".repeat(12)),
          ctB64: btoa("c".repeat(48)),
        },
        encryptionContext,
      },
    ],
  };
}

describe("manifest canonical map integrity", () => {
  it("preserves nested own __proto__ metadata without changing the object prototype", () => {
    const wire = '{"outer":{"__proto__":"one","a":"two"}}';
    const input = JSON.parse(wire);
    expect(canonicalizeToString(input)).toBe(wire);
    expect(Object.getPrototypeOf(input.outer)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "a")).toBe(false);
  });
  it.each(["__proto__", "constructor", "prototype", "ordinary"])(
    "authenticates the actual %s map value with the root-derived HMAC",
    async (key) => {
      const root = new Uint8Array(32).fill(17);
      try {
        // Well-shaped public metadata; this fixture grants no KMS or vault access.
        const context = Object.fromEntries([[key, "signed public metadata"]]);
        const signed = await sealAuthenticatedManifest(root, manifest(context));
        await verifyManifestAuth(root, signed);
        const changed = JSON.parse(JSON.stringify(signed));
        changed.records[0].encryptionContext[key] = "modified public metadata";
        await expect(verifyManifestAuth(root, changed)).rejects.toMatchObject({
          code: "manifest_auth_failed",
        });
      } finally {
        root.fill(0);
      }
    },
  );
});
