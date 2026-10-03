import type {
  ProtectionRecord,
  RootProtectionManifest,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  ProtectionError,
  assertCanRemoveProtector,
  dependsOnVault,
  isVerifiedIndependentPath,
  parseRootProtectionManifest,
  verifiedIndependentRecords,
} from "./index.js";
import { listProtectorViewRows } from "./protection-view.js";

const sealed = { ivB64: "YQ==", ctB64: "YQ==" };

const password: ProtectionRecord = {
  kind: "password",
  protectorId: "pw",
  legacy: true,
  kdf: { alg: "PBKDF2-SHA256", saltB64: "YQ==", iterations: 600000 },
  wrap: sealed,
  proofStatus: "verified",
};

const awsKms: ProtectionRecord = {
  kind: "aws-kms",
  protectorId: "aws",
  keyArn: "arn:aws:kms:us-east-1:123456789012:key/x",
  region: "us-east-1",
  connectionId: "aws-kms",
  connectionConfigVersion: "1",
  wrappedSecretB64: "YQ==",
  localCapsule: sealed,
  encryptionContext: {},
  proofStatus: "verified",
};

const gcpKms: ProtectionRecord = {
  kind: "gcp-kms",
  protectorId: "gcp",
  keyName: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
  connectionId: "gcp-kms",
  connectionConfigVersion: "1",
  wrappedSecretB64: "YQ==",
  localCapsule: sealed,
  aadB64: "YQ==",
  proofStatus: "verified",
};

const azure: ProtectionRecord = {
  kind: "azure-key-vault-keys",
  protectorId: "az",
  versionedKeyId: "https://v.vault.azure.net/keys/k/1",
  algorithm: "RSA-OAEP-256",
  connectionId: "azure",
  connectionConfigVersion: "1",
  tenantId: "t",
  wrappedSecretB64: "YQ==",
  localCapsule: sealed,
  proofStatus: "verified",
};

const recoveryKey: ProtectionRecord = {
  kind: "recovery-key",
  protectorId: "rk",
  wrap: sealed,
  fingerprintB64: "ZnA=",
  proofStatus: "verified",
};

const ageUntested: ProtectionRecord = {
  kind: "age-recipient",
  protectorId: "age",
  recipients: ["age1abc"],
  capsuleAgeB64: "YQ==",
  proofStatus: "untested",
};

function manifestOf(...records: ProtectionRecord[]): RootProtectionManifest {
  return {
    schemaVersion: 1,
    vaultId: "v",
    rootKeyId: "r",
    rootEpoch: 0,
    revision: 1,
    purpose: "human-vault-root",
    records,
  };
}

describe("independent unlock path (proof is not bootstrap independence)", () => {
  it("refuses removing the password while the only other path is a verified AWS KMS key", () => {
    const manifest = manifestOf(password, awsKms);
    expect(isVerifiedIndependentPath(awsKms)).toBe(false);
    expect(verifiedIndependentRecords(manifest)).toEqual([password]);
    expect(() => assertCanRemoveProtector(manifest, "pw")).toThrowError(
      ProtectionError,
    );
    expect(() => assertCanRemoveProtector(manifest, "pw")).toThrowError(
      /last verified independent/,
    );
  });

  it("refuses the same for Google Cloud KMS", () => {
    expect(() =>
      assertCanRemoveProtector(manifestOf(password, gcpKms), "pw"),
    ).toThrowError(/last verified independent/);
  });

  it("allows removing the password once a verified recovery key stands beside it", () => {
    const manifest = manifestOf(password, awsKms, recoveryKey);
    expect(verifiedIndependentRecords(manifest)).toEqual([
      password,
      recoveryKey,
    ]);
    expect(() => assertCanRemoveProtector(manifest, "pw")).not.toThrow();
  });

  it("still refuses removing the recovery key when it is the only independent path left", () => {
    expect(() =>
      assertCanRemoveProtector(manifestOf(recoveryKey, awsKms), "rk"),
    ).toThrowError(/last verified independent/);
  });

  it("lets a cloud protector itself be removed: it was never a way in", () => {
    expect(() =>
      assertCanRemoveProtector(manifestOf(password, awsKms), "aws"),
    ).not.toThrow();
  });

  it("counts a verified age recipient, never an untested one", () => {
    const verified: ProtectionRecord = {
      ...ageUntested,
      proofStatus: "verified",
    };
    expect(isVerifiedIndependentPath(verified)).toBe(true);
    expect(isVerifiedIndependentPath(ageUntested)).toBe(false);
    expect(() =>
      assertCanRemoveProtector(manifestOf(password, verified), "pw"),
    ).not.toThrow();
    expect(() =>
      assertCanRemoveProtector(manifestOf(password, ageUntested), "pw"),
    ).toThrowError(/last verified independent/);
  });

  it("names every cloud kind as vault-dependent and the rest as not", () => {
    for (const record of [awsKms, gcpKms, azure]) {
      expect(dependsOnVault(record)).toBe(true);
    }
    for (const record of [password, recoveryKey, ageUntested]) {
      expect(dependsOnVault(record)).toBe(false);
    }
  });

  it("reads a manifest written before this check unchanged, and applies the guard to it", () => {
    // Exactly the JSON an earlier build stored: no custody field exists.
    const stored = JSON.stringify(manifestOf(password, awsKms));
    const parsed = parseRootProtectionManifest(stored);
    expect(JSON.stringify(parsed)).toBe(stored);
    expect(() => assertCanRemoveProtector(parsed, "pw")).toThrowError(
      /last verified independent/,
    );
  });

  it("the view says which verified rows are not a way in", () => {
    const rows = listProtectorViewRows(manifestOf(password, awsKms));
    expect(rows.map((row) => [row.kind, row.dependsOnVault])).toEqual([
      ["password", false],
      ["aws-kms", true],
    ]);
    expect(rows.every((row) => row.proofStatus === "verified")).toBe(true);
  });
});
