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

export type OrganizationRole = "owner" | "admin" | "member";

export interface OrganizationMembership {
  organizationId: string;
  principalId: PrincipalId;
  role: OrganizationRole;
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

/**
 * Projects are the top-level grouping: vaults, agents, sites and other
 * resources all belong to exactly one project.
 *
 * - `personal` — auto-provisioned default project every principal gets;
 *   cannot be shared or deleted.
 * - `standard` — user-created project; optionally shareable via memberships.
 * - `temporary` — TTL-bound project minted through the claims flow.
 */
export type ProjectKind = "personal" | "standard" | "temporary";

export interface Project {
  id: string;
  kind: ProjectKind;
  organizationId?: string;
  ownerPrincipalId?: PrincipalId;
  slug: string;
  displayName: string;
  state: ProjectState;
  expiresAt?: Date;
  claimPolicyId?: string;
  /**
   * Opaque sealed-store tomb name for this project (Host/CLI interpret).
   * Personal projects default to the canonical personal tomb binding.
   */
  sealedStoreTombName?: string;
  /**
   * Opaque Pages vault folder id for this project (client plane interpret).
   * Host never decrypts vault contents.
   */
  pagesVaultFolderId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectRole = "owner" | "admin" | "member";

/** Grants a principal access to a shared project. */
export interface ProjectMembership {
  projectId: string;
  principalId: PrincipalId;
  role: ProjectRole;
  createdAt: Date;
  updatedAt: Date;
}

/** Canonical slug for a principal's default personal project. */
export const PERSONAL_PROJECT_SLUG = "personal" as const;

/** Secret/config environment scope within a project (Doppler-parity config). */
export type SecretConfigEnvironment =
  | "development"
  | "staging"
  | "production"
  | "custom";

/**
 * Project-scoped secret config (env slice). Type shape only — values stay in
 * sealed-store / vault; agents never receive raw secrets.
 */
export interface SecretConfig {
  id: string;
  projectId: string;
  slug: string;
  displayName: string;
  environment: SecretConfigEnvironment;
}

/** Sync-target lifecycle status for Host fan-out (WP-C). */
export type SyncTargetStatus = "idle" | "syncing" | "ready" | "error";

/**
 * Binds a project config to a connection + connector operation for sync fan-out.
 * Type shape only in this package — no invoke / getSecret affordance.
 */
export interface SyncTarget {
  id: string;
  projectId: string;
  configId: string;
  connectionId: string;
  providerId: string;
  operation: string;
  status: SyncTargetStatus;
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
  /** Project the agent belongs to (defaults to the owner's personal project). */
  projectId?: string;
  /** Principal that registered the agent — only they may claim or mutate it. */
  ownerPrincipalId: string;
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
  /** Principal that registered the client — only they may read or mutate it. */
  ownerPrincipalId: string;
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
  /** Digest of the preceding event in the trail — tamper evidence, not a signature. */
  previousDigest?: string;
  /** Digest of this event over its own fields and `previousDigest`. */
  digest?: string;
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

/** Connection lifecycle events the broker emits today (ADR 0032). */
export type ConnectionDomainEventType =
  | "connection.created"
  | "connection.authorized"
  | "connection.refreshed"
  | "connection.refresh_failed"
  | "connection.bound"
  | "connection.unbound"
  | "connection.revoked";

/** Personal project provisioning (WP-B). */
export type ProjectDomainEventType = "project.personal.ensured";

/** Secret/config changelog event types (frozen for WP-C/D/E). */
export type SecretConfigDomainEventType =
  | "secret.config.created"
  | "secret.config.updated"
  | "secret.config.deleted"
  | "secret.value.changed";

/** Sync-target event types (frozen for WP-C/D). */
export type SyncTargetDomainEventType =
  | "sync.target.created"
  | "sync.target.synced"
  | "sync.target.failed";

/** Credential rotation event types (frozen for WP-E). */
export type CredentialRotationDomainEventType =
  | "credential.rotation.requested"
  | "credential.rotation.succeeded"
  | "credential.rotation.failed";

/** Domain event types for projects / secrets / sync / rotation. */
export type SecretsPlaneDomainEventType =
  | ProjectDomainEventType
  | SecretConfigDomainEventType
  | SyncTargetDomainEventType
  | CredentialRotationDomainEventType;

/** Future domain event types — contracts only; no secret resolver in this slice. */
export type FutureDomainEventType =
  | "connection.claimed"
  | "connection.delegated"
  | "authority.invocation.requested"
  | "authority.invocation.completed";

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
