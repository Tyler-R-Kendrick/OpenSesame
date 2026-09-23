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
  /**
   * The stored pairwise key (`pairwiseSectorKey(sectorIdentifier)` when the
   * row was written); durable stores set it, the memory store derives it.
   */
  sectorKey?: string;
  /**
   * Set on a row that may not mint a pairwise `sub` — another owner holds its
   * key, its legacy spelling could not be keyed exactly, or an operator
   * released the key from its owner. The pairwise callback refuses it; its
   * owner re-registers.
   */
  sectorKeyBlocked?:
    | "cross_owner_collision"
    | "unparsed_legacy_spelling"
    | "sector_released";
  /**
   * The sector claim generation this row was admitted under; durable stores
   * set it. Above zero it is mixed into the pairwise subject sector
   * (`pairwiseSubjectSector`), so a holder admitted after an operator release
   * never meets an earlier holder's subjects.
   */
  sectorGeneration?: number;
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  allowedScopes: string[];
  allowedResources: string[];
  metadataUri?: string;
  metadataDigest?: string;
  /** Public JWKS for `private_key_jwt`. Never stores private key material. */
  jwks?: { keys: import("@opensesame/os-domain").JsonObject[] };
  /**
   * RFC 8705 registration (pre-registered/admin path only — never DCR).
   * Exactly one SAN selector for `tls_client_auth`; compared exactly.
   */
  tlsClientAuthSanDns?: string;
  tlsClientAuthSanUri?: string;
  /** Every access token this client obtains carries `cnf["x5t#S256"]`. */
  tlsClientCertificateBoundAccessTokens?: boolean;
  state: ClientState;
  /** Origin-profile clients are constrained (no offline_access / admin scopes). */
  origin?: string;
  ownershipStatus?: OwnershipStatus;
  /**
   * Registering/owning principal. Origin-profile clients are born owned by
   * the deployment/system principal (ADR 0050 R-A) and the F5 claim flow
   * transfers ownership to the claiming principal. Optional only so
   * store-fixtures and pre-R-A records remain representable.
   */
  ownerPrincipalId?: string;
  firstSeenAt?: Date;
  lastUsedAt?: Date;
  claimedAt?: Date;
  /** Registration-API bookkeeping (durable rows always carry these). */
  createdAt?: Date;
  updatedAt?: Date;
}

/** What an operator release of a sector key did (`ClientRecordStore`). */
export interface SectorKeyRelease {
  sectorKey: string;
  /** The owner that held the key until now (`client:<id>` when ownerless). */
  previousOwnerKey: string;
  /** The generation the next holder's subjects live under. */
  generation: number;
  /** Who now holds the key: the named next owner, or null (open). */
  nextOwnerKey: string | null;
  /** Clients that lost the key (blocked `sector_released`). */
  blockedClientIds: string[];
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
