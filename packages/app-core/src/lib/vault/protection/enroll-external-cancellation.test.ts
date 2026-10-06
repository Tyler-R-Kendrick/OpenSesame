import type { RootProtectionManifest } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import {
  type ExternalEnrollment,
  provenExternalRecord,
} from "./enroll-external.js";
import {
  GCP_KEY,
  KEY_ARN,
  aws,
  awsFake,
  gcpFake,
} from "./protector-enrollment.test-support.js";

const BASE: RootProtectionManifest = {
  schemaVersion: 1,
  vaultId: "vault-cancellation",
  rootKeyId: "root-cancellation",
  rootEpoch: 1,
  revision: 1,
  purpose: "human-vault-root",
  records: [],
};

function provider(kind: "aws-kms" | "gcp-kms") {
  if (kind === "aws-kms") {
    const transport = awsFake(KEY_ARN);
    return {
      enrollment: aws(transport),
      encrypt: vi.spyOn(transport, "encrypt"),
      decrypt: vi.spyOn(transport, "decrypt"),
    };
  }
  const transport = gcpFake();
  const enrollment: ExternalEnrollment = {
    kind,
    transport,
    keyName: GCP_KEY,
    connectionId: "gcp-kms",
    connectionConfigVersion: "1",
  };
  return {
    enrollment,
    encrypt: vi.spyOn(transport, "encrypt"),
    decrypt: vi.spyOn(transport, "decrypt"),
  };
}

describe("loading a selected cloud protector", () => {
  for (const kind of ["aws-kms", "gcp-kms"] as const) {
    it(`cancels ${kind} before its newly loaded provider receives key material`, async () => {
      const controller = new AbortController();
      const { enrollment, encrypt, decrypt } = provider(kind);
      const pending = provenExternalRecord({
        enrollment,
        base: BASE,
        rootKey: crypto.getRandomValues(new Uint8Array(32)),
        operationId: "canceled-cloud-enrollment",
        sessionGeneration: 1,
        signal: controller.signal,
        context: (protectorId) => ({
          vaultId: BASE.vaultId,
          rootKeyId: BASE.rootKeyId,
          rootEpoch: BASE.rootEpoch,
          purpose: BASE.purpose,
          protectorId,
        }),
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "canceled" });
      expect(encrypt).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
      expect(BASE.records).toEqual([]);
    });
  }
});
