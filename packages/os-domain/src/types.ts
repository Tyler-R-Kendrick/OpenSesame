/**
 * Pure OpenSesame identity-plane domain types.
 * No framework imports (hono/drizzle/better-auth/oidc-provider).
 */

export type PrincipalId = string;

/** Lifecycle of a principal. Provisional is a state on Principal — not a separate type. */
export type PrincipalState = "provisional" | "active" | "suspended" | "closed";

export type AssuranceLevel =
  | "provisional"
  | "self_asserted"
  | "verified"
  | "mfa"
  | "phishing_resistant"
  | "enterprise_managed"
  | "workload_attested";

export interface Principal {
  id: PrincipalId;
  state: PrincipalState;
  assurance: AssuranceLevel;
  createdAt: Date;
  updatedAt: Date;
  verifiedAt?: Date;
  suspendedAt?: Date;
  version: number;
}

export type ExternalIdentityKind =
  | "oidc"
  | "oauth_profile"
  | "passkey"
  | "atproto"
  | "nostr"
  | "spiffe"
  | "auth_md"
  | "enterprise_directory";

export interface ExternalIdentity {
  id: string;
  principalId: PrincipalId;
  kind: ExternalIdentityKind;
  issuer: string;
  tenant?: string;
  subject: string;
  displayHint?: string;
  emailNormalized?: string;
  emailVerified?: boolean;
  assurance: AssuranceLevel;
  linkedAt: Date;
  lastAuthenticatedAt?: Date;
  metadata: Record<string, unknown>;
}

export interface BetterAuthSubject {
  betterAuthUserId: string;
  principalId: PrincipalId;
  linkedAt: Date;
}

export type OrganizationState =
  | "provisional"
  | "active"
  | "suspended"
  | "deleted";

export interface Organization {
  id: string;
  slug: string;
  displayName: string;
  state: OrganizationState;
  createdBy: PrincipalId;
  createdAt: Date;
  updatedAt: Date;
}

export interface Team {
  id: string;
  organizationId: string;
  slug: string;
  displayName: string;
  createdAt: Date;
}

export type ProjectState =
  | "provisional"
  | "active"
  | "expired"
  | "deleting"
  | "deleted";

export interface Project {
  id: string;
  organizationId?: string;
  ownerPrincipalId?: PrincipalId;
  slug: string;
  displayName: string;
  state: ProjectState;
  expiresAt?: Date;
  claimPolicyId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ResourceState =
  | "provisional"
  | "active"
  | "expired"
  | "deleting"
  | "deleted"
  | "quarantined";

export interface Resource {
  id: string;
  projectId?: string;
  organizationId?: string;
  kind: string;
  state: ResourceState;
  ownerPrincipalId?: PrincipalId;
  manifest: Record<string, unknown>;
  expiresAt?: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type OwnershipSubjectType = "principal" | "organization";
export type OwnershipObjectType =
  | "project"
  | "resource"
  | "agent"
  | "device"
  | "connection";
export type OwnershipRelation = "owner" | "custodian" | "administrator";

export interface Ownership {
  id: string;
  subjectType: OwnershipSubjectType;
  subjectId: string;
  objectType: OwnershipObjectType;
  objectId: string;
  relation: OwnershipRelation;
  createdAt: Date;
  sourceClaimId?: string;
}

export type AgentState = "provisional" | "claimed" | "suspended" | "revoked";

export interface Agent {
  id: string;
  displayName: string;
  provider?: string;
  softwareIdentity?: string;
  state: AgentState;
  createdAt: Date;
}

export interface AgentInstance {
  id: string;
  agentId: string;
  publicKeyJkt: string;
  clientId?: string;
  runtimeProvider?: string;
  attestationDigest?: string;
  createdAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
}

export type DelegationRelationship = "owns" | "operates" | "delegates_to";

export interface Delegation {
  id: string;
  principalId: PrincipalId;
  agentId: string;
  projectId?: string;
  grantId?: string;
  relationship: DelegationRelationship;
  createdAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
}

export type ClientAdmissionMode =
  | "pre_registered"
  | "dynamic_registration"
  | "client_metadata_document"
  | "origin_profile";

export type OAuthClientState = "active" | "suspended" | "revoked";

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
  state: OAuthClientState;
  createdAt: Date;
  updatedAt: Date;
}

export interface PairwiseSubject {
  principalId: PrincipalId;
  sectorIdentifier: string;
  subject: string;
  createdAt: Date;
}

export interface Consent {
  id: string;
  principalId: PrincipalId;
  clientId: string;
  sectorIdentifier: string;
  scopes: string[];
  resources: string[];
  claims: string[];
  organizationId?: string;
  projectId?: string;
  grantedAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  version: number;
}

/**
 * Bounded provisional capability bound to a proof key / browser session.
 * Distinct from ClaimSession and DeviceAuthorizationSession.
 */
export interface ProvisionalSession {
  id: string;
  principalId: PrincipalId;
  instanceKeyJkt?: string;
  quotaProfile: string;
  allowedActions: string[];
  createdAt: Date;
  expiresAt: Date;
  claimedAt?: Date;
  revokedAt?: Date;
  lastSeenAt?: Date;
}

export type ClaimTargetType =
  | "principal"
  | "agent"
  | "project"
  | "resource_bundle"
  | "device"
  | "connection";

export type ClaimState =
  | "pending"
  | "presented"
  | "authenticated"
  | "reviewed"
  | "completed"
  | "denied"
  | "revoked"
  | "expired";

export interface ClaimSession {
  id: string;
  type: ClaimTargetType;
  state: ClaimState;
  creatorPrincipalId?: PrincipalId;
  creatorAgentId?: string;
  creatorInstanceId?: string;
  tokenDigest: Uint8Array;
  userCodeDigest?: Uint8Array;
  proofKeyJkt?: string;
  targetManifest: Record<string, unknown>;
  /** Immutable after create — never mutate in place. */
  targetManifestDigest: string;
  requestedDestination?: Record<string, unknown>;
  requestedGrant?: Record<string, unknown>;
  createdAt: Date;
  presentedAt?: Date;
  authenticatedAt?: Date;
  reviewedAt?: Date;
  completedAt?: Date;
  expiresAt: Date;
  revokedAt?: Date;
  completedByPrincipalId?: PrincipalId;
  reviewDecision?: Record<string, unknown>;
  version: number;
}

export type ClaimItemTargetType =
  | "project"
  | "resource"
  | "agent"
  | "device"
  | "connection";

export type ClaimItemAction = "attach" | "transfer" | "delegate" | "verify";
export type ClaimItemState = "pending" | "accepted" | "rejected";

export interface ClaimItem {
  id: string;
  claimId: string;
  targetType: ClaimItemTargetType;
  targetId: string;
  required: boolean;
  dependencies: string[];
  requestedAction: ClaimItemAction;
  state: ClaimItemState;
  snapshotVersion: number;
  snapshotDigest: string;
}

/**
 * RFC 8628 device authorization projection — NOT a ClaimSession.
 * Prefer oidc-provider for protocol; this model is for UI/policy/audit.
 */
export type DeviceAuthorizationState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";

export interface DeviceAuthorizationSession {
  id: string;
  clientId: string;
  deviceCodeDigest: Uint8Array;
  userCodeDigest: Uint8Array;
  requestedScopes: string[];
  requestedResources: string[];
  proofKeyJkt?: string;
  state: DeviceAuthorizationState;
  intervalSeconds: number;
  createdAt: Date;
  expiresAt: Date;
  approvedByPrincipalId?: PrincipalId;
  approvedAt?: Date;
  consumedAt?: Date;
  pollCount: number;
  lastPolledAt?: Date;
}

export type AuditActorType = "human" | "agent" | "workload" | "system";
export type AuditOutcome = "succeeded" | "failed" | "denied";

export interface AuditEvent {
  id: string;
  occurredAt: Date;
  eventType: string;
  principalId?: string;
  actorType?: AuditActorType;
  actorId?: string;
  agentInstanceId?: string;
  clientId?: string;
  organizationId?: string;
  projectId?: string;
  claimId?: string;
  sessionId?: string;
  targetType?: string;
  targetId?: string;
  outcome: AuditOutcome;
  correlationId: string;
  causationId?: string;
  metadata: Record<string, unknown>;
}

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  availableAt: Date;
  publishedAt?: Date;
  attempts: number;
  lastError?: string;
}

export type Clock = () => Date;

/**
 * Future authority-plane seam (ADR 0005). Possessing a handle never implies
 * permission to materialize underlying secret material.
 */
export type AuthorityHandle =
  | { kind: "connection"; ref: string }
  | { kind: "credential"; ref: string }
  | { kind: "key"; ref: string }
  | { kind: "certificate_authority"; ref: string }
  | { kind: "signer"; ref: string }
  | { kind: "secret"; ref: string };

export type ConnectionRef = { kind: "connection"; ref: string };

/** Future domain event types — contracts only; no secret resolver in this slice. */
export type FutureDomainEventType =
  | "connection.claimed"
  | "connection.delegated"
  | "authority.invocation.requested"
  | "authority.invocation.completed"
  | "credential.rotation.requested";

export interface SigningKeyProvider {
  getActiveSigningKeys(): Promise<readonly JsonWebKey[]>;
  getJwks(): Promise<{ keys: readonly JsonWebKey[] }>;
  rotationStatus(): Promise<{ activeKid: string; retiringKids: string[] }>;
}

export interface AbuseChallengeProvider {
  challenge(input: {
    action: string;
    ip?: string;
    principalId?: string;
    proofKeyJkt?: string;
  }): Promise<{ allowed: boolean; retryAfterMs?: number; challenge?: string }>;
}

export class NoopAbuseChallengeProvider implements AbuseChallengeProvider {
  async challenge(): Promise<{ allowed: boolean }> {
    return { allowed: true };
  }
}
