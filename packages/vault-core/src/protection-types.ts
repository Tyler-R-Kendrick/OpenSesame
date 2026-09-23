/**
 * Shared root-protection contracts (C03). Serializable metadata only —
 * secret handles live in adapter.ts.
 */

import type { MANIFEST_SCHEMA_VERSION } from "./protection-limits.js";

export type ProtectorKind =
  | "password"
  | "pin"
  | "webauthn-prf"
  | "device-local"
  | "age-recipient"
  | "age-webauthn"
  | "yubikey-piv-age"
  | "recovery-key"
  | "aws-kms"
  | "azure-key-vault-keys"
  | "gcp-kms";

export type ProtectionPurpose = "human-vault-root" | "workload-root";

export type ProtectionContext = {
  vaultId: string;
  rootKeyId: string;
  rootEpoch: number;
  protectorId: string;
  purpose: ProtectionPurpose;
};

export type ProtectorAvailability = {
  implementation: "implemented" | "unsupported";
  runtime: "available" | "requires-native-client" | "unavailable";
  authorization:
    | "not-required"
    | "missing"
    | "pending"
    | "authorized"
    | "expired";
  reasonCode?: string;
};

export type VerificationEvidenceKind =
  | "contract"
  | "software-roundtrip"
  | "browser"
  | "hardware"
  | "cloud-live";

export type VerificationEvidence = {
  kind: VerificationEvidenceKind;
  implementationVersion: string;
  testedAt: string;
  evidenceRef: string;
};

export type ProofStatus = "verified" | "untested" | "stale";

export type SealedBlobV1 = {
  ivB64: string;
  ctB64: string;
};

export type PasswordProtectorRecord = {
  kind: "password";
  protectorId: string;
  legacy: true;
  kdf: {
    alg: "PBKDF2-SHA256";
    saltB64: string;
    iterations: number;
  };
  wrap: SealedBlobV1;
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type PinProtectorRecord = {
  kind: "pin";
  protectorId: string;
  legacy: true;
  saltB64: string;
  iterations: number;
  wrap: SealedBlobV1;
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type WebauthnPrfProtectorRecord = {
  kind: "webauthn-prf";
  protectorId: string;
  legacy: boolean;
  credentialIdB64: string;
  rpId: string;
  saltB64: string;
  wrap: SealedBlobV1;
  userVerification: "required" | "preferred" | "discouraged";
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type AgeRecipientProtectorRecord = {
  kind: "age-recipient";
  protectorId: string;
  recipients: string[];
  capsuleAgeB64: string;
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type AgeWebauthnProtectorRecord = {
  kind: "age-webauthn";
  protectorId: string;
  recipient: string;
  capsuleAgeB64: string;
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type YubikeyPivAgeProtectorRecord = {
  kind: "yubikey-piv-age";
  protectorId: string;
  recipient: string;
  serialHint?: string;
  capsuleAgeB64: string;
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type RecoveryKeyProtectorRecord = {
  kind: "recovery-key";
  protectorId: string;
  wrap: SealedBlobV1;
  /** Public fingerprint only — never the recovery secret. */
  fingerprintB64: string;
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type AwsKmsProtectorRecord = {
  kind: "aws-kms";
  protectorId: string;
  keyArn: string;
  region: string;
  connectionId: string;
  connectionConfigVersion: string;
  wrappedSecretB64: string;
  localCapsule: SealedBlobV1;
  encryptionContext: Record<string, string>;
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type AzureKeyVaultKeysProtectorRecord = {
  kind: "azure-key-vault-keys";
  protectorId: string;
  versionedKeyId: string;
  algorithm: "RSA-OAEP-256";
  connectionId: string;
  connectionConfigVersion: string;
  tenantId: string;
  wrappedSecretB64: string;
  localCapsule: SealedBlobV1;
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type GcpKmsProtectorRecord = {
  kind: "gcp-kms";
  protectorId: string;
  keyName: string;
  keyVersionName?: string;
  connectionId: string;
  connectionConfigVersion: string;
  wrappedSecretB64: string;
  localCapsule: SealedBlobV1;
  aadB64: string;
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type DeviceLocalProtectorRecord = {
  kind: "device-local";
  protectorId: string;
  mechanism: string;
  wrap: SealedBlobV1;
  proofStatus: ProofStatus;
  lastEvidence?: VerificationEvidence;
};

export type ProtectionRecord =
  | PasswordProtectorRecord
  | PinProtectorRecord
  | WebauthnPrfProtectorRecord
  | AgeRecipientProtectorRecord
  | AgeWebauthnProtectorRecord
  | YubikeyPivAgeProtectorRecord
  | RecoveryKeyProtectorRecord
  | AwsKmsProtectorRecord
  | AzureKeyVaultKeysProtectorRecord
  | GcpKmsProtectorRecord
  | DeviceLocalProtectorRecord;

/** App confirmation gates authenticated with the manifest — not offline MFA. */
export type AuthenticatedLegacyGates = {
  totpEnrolled: boolean;
  emailEnrolled: boolean;
  smsEnrolled: boolean;
  recoveryCodesEnrolled: boolean;
};

export type RootProtectionManifest = {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  vaultId: string;
  rootKeyId: string;
  rootEpoch: number;
  /** Mutable; authenticated in the manifest MAC, never in wrapper AAD. */
  revision: number;
  purpose: ProtectionPurpose;
  records: ProtectionRecord[];
  preferredProtectorId?: string;
  legacyGates?: AuthenticatedLegacyGates | undefined;
  /** Base64url HMAC/AEAD tag over canonical manifest without this field. */
  authB64?: string;
};

export type EncryptionSetupIntent = {
  providerId: string;
  connectionId?: string;
  /** Preference only — not an enrolled protector. */
  source: "capabilityConnectors.encryption";
};
