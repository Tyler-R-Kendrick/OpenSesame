/**
 * Typed protector records and headers for the Vault key protection tests: each
 * is a complete record of its kind, so a test names the shape it means instead
 * of passing a partial object through a cast.
 */

import type {
  ProtectionRecord,
  SealedBlobV1,
  VaultHeader,
} from "@opensesame/vault-core";

const sealed: SealedBlobV1 = { ivB64: "aXY=", ctB64: "Y3Q=" };

export type VaultViewState = {
  guest: boolean;
  status: string;
  tomb?: string;
};

export function passwordHeader(): VaultHeader {
  return {
    v: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    kdf: { alg: "PBKDF2-SHA256", saltB64: "c2FsdA==", iterations: 600_000 },
    wrap: sealed,
  };
}

/** The password header with a manifest that holds exactly these records. */
export function headerWithRecords(records: ProtectionRecord[]): VaultHeader {
  return {
    ...passwordHeader(),
    protection: {
      schemaVersion: 1,
      vaultId: "vault_x",
      rootKeyId: "root_x",
      rootEpoch: 0,
      revision: 1,
      purpose: "human-vault-root",
      records,
      authB64: "YXV0aA==",
    },
  };
}

export const pin: ProtectionRecord = {
  kind: "pin",
  protectorId: "pin_a",
  legacy: true,
  saltB64: "c2FsdA==",
  iterations: 100_000,
  wrap: sealed,
  proofStatus: "verified",
};

export const passkeyWrap: ProtectionRecord = {
  kind: "webauthn-prf",
  protectorId: "prf_a",
  legacy: true,
  credentialIdB64: "Y3JlZA==",
  rpId: "localhost",
  saltB64: "c2FsdA==",
  wrap: sealed,
  userVerification: "preferred",
  proofStatus: "verified",
};

export const recoveryKey: ProtectionRecord = {
  kind: "recovery-key",
  protectorId: "recovery-key_a",
  wrap: sealed,
  fingerprintB64: "ZnA=",
  proofStatus: "verified",
};

export const ageRecipient: ProtectionRecord = {
  kind: "age-recipient",
  protectorId: "age_1",
  recipients: ["age1abc"],
  capsuleAgeB64: "Y2Fwc3VsZQ==",
  proofStatus: "untested",
};

export const agePasskey: ProtectionRecord = {
  kind: "age-webauthn",
  protectorId: "agew_1",
  recipient: "AGE-PLUGIN-FIDO2PRF-1-X",
  capsuleAgeB64: "Y2Fwc3VsZQ==",
  proofStatus: "verified",
};

/** An AWS KMS protector wrapping with the key `keyArn`. */
export function awsKmsOn(keyArn: string): ProtectionRecord {
  return {
    kind: "aws-kms",
    protectorId: "aws_1",
    keyArn,
    region: "us-east-1",
    connectionId: "aws-kms",
    connectionConfigVersion: "1",
    wrappedSecretB64: "d3JhcHBlZA==",
    localCapsule: sealed,
    encryptionContext: {},
    proofStatus: "verified",
  };
}

export const awsKms: ProtectionRecord = awsKmsOn(
  "arn:aws:kms:us-east-1:123456789012:key/x",
);

/** A Google Cloud KMS protector wrapping with the crypto key `keyName`. */
export function gcpKmsOn(keyName: string): ProtectionRecord {
  return {
    kind: "gcp-kms",
    protectorId: "gcp_1",
    keyName,
    connectionId: "gcp-kms",
    connectionConfigVersion: "1",
    wrappedSecretB64: "d3JhcHBlZA==",
    localCapsule: sealed,
    aadB64: "YWFk",
    proofStatus: "verified",
  };
}

export const gcpKms: ProtectionRecord = gcpKmsOn(
  "projects/p/locations/l/keyRings/r/cryptoKeys/k",
);

export const yubikey: ProtectionRecord = {
  kind: "yubikey-piv-age",
  protectorId: "yk_1",
  recipient: "age1yubikey1x",
  capsuleAgeB64: "Y2Fwc3VsZQ==",
  proofStatus: "verified",
};

export const azure: ProtectionRecord = {
  kind: "azure-key-vault-keys",
  protectorId: "az_1",
  versionedKeyId: "https://v.vault.azure.net/keys/k/1",
  algorithm: "RSA-OAEP-256",
  connectionId: "azure",
  connectionConfigVersion: "1",
  tenantId: "00000000-0000-0000-0000-000000000000",
  wrappedSecretB64: "d3JhcHBlZA==",
  localCapsule: sealed,
  proofStatus: "verified",
};

export const deviceLocal: ProtectionRecord = {
  kind: "device-local",
  protectorId: "dl_1",
  mechanism: "secure-enclave",
  wrap: sealed,
  proofStatus: "verified",
};
