import type { JsonObject } from "./json.js";

export type HumanIdentityProofing =
  | "none"
  | "self_attested"
  | "verified_account"
  | "remote_unattended"
  | "remote_attended"
  | "in_person"
  | "enterprise_asserted";
export type UserVerification =
  | "none"
  | "presence"
  | "local_user_verification"
  | "remote_user_verification";
export type KeyProtection =
  | "unknown"
  | "software_exportable"
  | "software_non_exportable"
  | "tee_backed"
  | "strongbox_backed"
  | "external_hardware";
export type DeviceBinding = "none" | "software" | "hardware";
export type Syncability = "unknown" | "single_device" | "multi_device";
export type SubjectKind = "human" | "agent" | "workload";
export interface AuthenticationFacts {
  authenticatedAt?: Date;
  userVerifiedAt?: Date;
  methods: string[];
  acr?: string;
  factorCount?: 0 | 1 | 2;
  userVerification: UserVerification;
  phishingResistant?: boolean;
  verifierNameBound?: boolean;
  deviceBinding: DeviceBinding;
  keyProtection: KeyProtection;
  syncability: Syncability;
}
export interface AssuranceVector {
  subjectKind: SubjectKind;
  identityProofing?: HumanIdentityProofing;
  authentication: AuthenticationFacts;
  federationIssuerTrust:
    | "unknown"
    | "allowlisted"
    | "pre_registered"
    | "federation_chain";
  evidenceIssuedAt?: Date;
  evidenceExpiresAt?: Date;
}
export interface AssuranceRequirement {
  subjectKind: SubjectKind;
  minimumIdentityProofing?: HumanIdentityProofing[];
  requireUserVerification?: boolean;
  requirePhishingResistance?: boolean;
  requireVerifierNameBinding?: boolean;
  minimumDeviceBinding?: DeviceBinding[];
  minimumKeyProtection?: KeyProtection[];
  maximumAuthenticationAgeSeconds?: number;
  maximumEvidenceAgeSeconds?: number;
  acceptableIssuers?: string[];
  acceptableAcrValues?: string[];
}
export type IdentityEvidenceSource =
  | "oidc_id_token"
  | "oidc_userinfo"
  | "oid4vci_credential"
  | "webauthn_assertion"
  | "enterprise_assertion"
  | "self_attested";
export type IdentityEvidenceState =
  | "active"
  | "expired"
  | "revoked"
  | "superseded";
export interface EvidenceClaimDescriptor {
  name: string;
  classification:
    | "identifier"
    | "contact"
    | "profile"
    | "membership"
    | "derived"
    | "authentication";
  issuer: string;
  verified: boolean;
  issuedAt?: Date;
  expiresAt?: Date;
}
export interface IdentityEvidence {
  id: string;
  principalId: string;
  externalIdentityId?: string;
  source: IdentityEvidenceSource;
  issuer: string;
  sourceSubjectDigest?: string;
  sourceArtifactDigest: string;
  claims: EvidenceClaimDescriptor[];
  assurance: AssuranceVector;
  acquiredAt: Date;
  verifiedAt: Date;
  expiresAt?: Date;
  state: IdentityEvidenceState;
  trustPolicyId: string;
  version: number;
  metadata: JsonObject;
}
export interface TrustSession {
  id: string;
  principalId: string;
  deviceId: string;
  proofKeyHandle: string;
  proofKeyJkt: string;
  assurance: AssuranceVector;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  version: number;
}
export interface TrustActivation {
  id: string;
  trustSessionId: string;
  transactionDigest: string;
  activatedAt: Date;
  expiresAt: Date;
  method: string;
  userVerification: UserVerification;
  keyProtection: KeyProtection;
}
export interface HeldCredentialMetadata {
  id: string;
  format: string;
  issuer: string;
  credentialType: string;
  holderKeyJkt: string;
  issuedAt: Date;
  expiresAt?: Date;
  statusReference?: JsonObject;
  encryptedPayloadRef: string;
  displayClaims: string[];
}
export interface IssuedCredentialRecord {
  id: string;
  principalId: string;
  credentialConfigurationId: string;
  format: string;
  credentialType: string;
  holderKeyJkt: string;
  credentialDigest: string;
  sourceEvidenceIds: string[];
  issuedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  statusReference?: JsonObject;
  version: number;
}
