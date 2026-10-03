import type { ProtectionRecord, VaultHeader } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  capsuleRecordsFor,
  capsuleTabOf,
  isProtectorUnlockMethod,
  listProtectorUnlockTabs,
} from "./unlock-protector-methods.js";

const wrap = { ivB64: "aXY=", ctB64: "Y3Q=" };

function headerWith(...records: ProtectionRecord[]): VaultHeader {
  return {
    v: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    protection: {
      schemaVersion: 1,
      vaultId: "v",
      rootKeyId: "r",
      rootEpoch: 0,
      revision: 1,
      purpose: "human-vault-root",
      records,
    },
  };
}

const recovery = (proofStatus: "verified" | "untested" = "verified") =>
  ({
    kind: "recovery-key",
    protectorId: "recovery_a",
    wrap,
    fingerprintB64: "ZnA=",
    proofStatus,
  }) satisfies ProtectionRecord;

const age = {
  kind: "age-recipient",
  protectorId: "age_a",
  recipients: ["age1x"],
  capsuleAgeB64: "Y3Q=",
  proofStatus: "verified",
} satisfies ProtectionRecord;

const agePasskey = {
  kind: "age-webauthn",
  protectorId: "agepk_a",
  recipient: "AGE-PLUGIN-WEBAUTHN-1X",
  capsuleAgeB64: "Y3Q=",
  proofStatus: "verified",
} satisfies ProtectionRecord;

const prf = (legacy: boolean) =>
  ({
    kind: "webauthn-prf",
    protectorId: legacy ? "prf_header" : "prf_capsule",
    legacy,
    credentialIdB64: "Y3JlZA==",
    rpId: "localhost",
    saltB64: "c2FsdA==",
    wrap,
    userVerification: "required",
    proofStatus: "verified",
  }) satisfies ProtectionRecord;

const aws = {
  kind: "aws-kms",
  protectorId: "aws_a",
  keyArn: "arn:aws:kms:us-west-2:1:key/x",
  region: "us-west-2",
  connectionId: "c",
  connectionConfigVersion: "1",
  wrappedSecretB64: "Y3Q=",
  localCapsule: wrap,
  encryptionContext: {},
  proofStatus: "verified",
} satisfies ProtectionRecord;

const gcp = {
  kind: "gcp-kms",
  protectorId: "gcp_a",
  keyName: "projects/p/locations/g/keyRings/r/cryptoKeys/k",
  keyVersionName: "projects/p/locations/g/keyRings/r/cryptoKeys/k/v/1",
  connectionId: "c",
  connectionConfigVersion: "1",
  wrappedSecretB64: "Y3Q=",
  localCapsule: wrap,
  encryptionContext: {},
  proofStatus: "verified",
} as unknown as ProtectionRecord;

describe("the tabs the manifest adds to the unlock screen", () => {
  it("names a recovery key, an age key and an age passkey, in that screen order", () => {
    const header = headerWith(recovery(), age, agePasskey);
    expect(listProtectorUnlockTabs(header)).toEqual([
      "agePasskey",
      "age",
      "recovery",
    ]);
  });

  it("draws a passkey tab only for a passkey capsule, never for the header's own wrap", () => {
    expect(listProtectorUnlockTabs(headerWith(prf(true)))).toEqual([]);
    expect(listProtectorUnlockTabs(headerWith(prf(false)))).toEqual([
      "passkey",
    ]);
  });

  it("never draws a cloud key: its credential is sealed in the vault it protects", () => {
    expect(listProtectorUnlockTabs(headerWith(aws, gcp))).toEqual([]);
    expect(capsuleTabOf(aws)).toBeNull();
    expect(capsuleTabOf(gcp)).toBeNull();
  });

  it("draws nothing for a protector that has not been proved", () => {
    expect(listProtectorUnlockTabs(headerWith(recovery("untested")))).toEqual(
      [],
    );
    expect(
      listProtectorUnlockTabs(headerWith({ ...age, proofStatus: "untested" })),
    ).toEqual([]);
  });

  it("draws nothing when there is no manifest, or a damaged one", () => {
    expect(listProtectorUnlockTabs(null)).toEqual([]);
    expect(listProtectorUnlockTabs({ v: 1, createdAt: "" })).toEqual([]);
    const damaged = headerWith();
    if (damaged.protection) {
      Object.assign(damaged.protection, { records: "nope" });
    }
    expect(listProtectorUnlockTabs(damaged)).toEqual([]);
  });

  it("finds exactly the records a tab can open", () => {
    const header = headerWith(recovery(), age, prf(false));
    expect(
      capsuleRecordsFor(header, "recovery").map((row) => row.protectorId),
    ).toEqual(["recovery_a"]);
    expect(capsuleRecordsFor(header, "pin")).toEqual([]);
  });

  it("recognises the ids it adds", () => {
    expect(isProtectorUnlockMethod("recovery")).toBe(true);
    expect(isProtectorUnlockMethod("agePasskey")).toBe(true);
    expect(isProtectorUnlockMethod("password")).toBe(false);
  });
});
