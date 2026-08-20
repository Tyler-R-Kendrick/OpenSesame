export type ClientAdmissionMode =
  | "pre_registered"
  | "dynamic_registration"
  | "client_metadata_document"
  | "origin_profile";

export type ClientState = "active" | "suspended" | "revoked";

/** Origin-profile clients begin unclaimed until the F5 claim flow runs. */
export type OwnershipStatus = "unclaimed" | "claimed";

export interface OAuthClientRecord {
  id: string;
  admissionMode: ClientAdmissionMode;
  displayName: string;
  redirectUris: string[];
  sectorIdentifier: string;
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  allowedScopes: string[];
  allowedResources: string[];
  metadataUri?: string;
  metadataDigest?: string;
  state: ClientState;
  /** Origin-profile clients are constrained (no offline_access / admin scopes). */
  origin?: string;
  ownershipStatus?: OwnershipStatus;
  /**
   * Registering/owning principal. Origin-profile clients start without one
   * (deployment/system-owned per ADR 0050 R-A) until the F5 claim flow
   * transfers ownership.
   */
  ownerPrincipalId?: string;
  firstSeenAt?: Date;
  lastUsedAt?: Date;
  claimedAt?: Date;
  /** Registration-API bookkeeping (durable rows always carry these). */
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PairwiseSubject {
  principalId: string;
  sectorIdentifier: string;
  subject: string;
  createdAt: Date;
}

export interface PairwiseSubjectStore {
  getOrCreate(
    principalId: string,
    sectorIdentifier: string,
  ): Promise<PairwiseSubject>;
  find(
    principalId: string,
    sectorIdentifier: string,
  ): Promise<PairwiseSubject | undefined>;
}

export interface OAuthProviderEnv {
  originClientsEnabled: boolean;
  dcrEnabled: boolean;
  cimdEnabled: boolean;
  issuer: string;
  /**
   * Resource indicators (RFC 8707) this issuer will mint access tokens for.
   * Empty means "issuer only" — never "anything the client asks for".
   */
  allowedResources: string[];
  /** Production refuses ephemeral signing keys and in-memory grant state. */
  isProduction: boolean;
}

export const ORIGIN_PROFILE_FORBIDDEN_SCOPES = [
  "offline_access",
  "admin",
  "opensesame.admin",
] as const;
