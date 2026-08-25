/**
 * Pure OpenSesame identity-plane domain types.
 * No framework imports (hono/drizzle/better-auth/oidc-provider).
 */

import type { JsonObject } from "./json.js";

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
  metadata: JsonObject;
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
  /**
   * OIDC issuer for this tenant's SSO. Absent means SSO is not offered.
   */
  ssoIssuer?: string;
  /**
   * SAML IdP entityID for native SAML (ADR 0056) when SAML metadata is
   * configured; otherwise the legacy meaning — the OIDC issuer of a
   * SAML-brokering Keycloak (ADR 0016).
   */
  samlIssuer?: string;
  /** Location of the SAML IdP metadata document (fetched under the SSRF guard). */
  samlMetadataUrl?: string;
  /** Inline SAML IdP metadata document, when the operator pasted it directly. */
  samlMetadataXml?: string;
  /**
   * SCIM directory provisioning is authoritative for this tenant: JIT-join
   * requires an active provisioned user. Absent means disabled.
   */
  provisioningEnabled?: boolean;
}

/**
 * Per-organization LDAP directory configuration (ADR 0057).
 *
 * The subject is a stable directory attribute, never the DN: a DN moves when
 * a person changes team, and a moved DN would mint a second principal.
 * `serviceBindSecret` is presented to the directory verbatim, so it is held
 * as-is — it is never an agent-facing value and never leaves the host plane.
 */
export interface OrgLdapConfig {
  organizationId: string;
  /** `ldap://` or `ldaps://`. Plain ldap is dev-only. */
  url: string;
  bindMode: OrgLdapBindMode;
  /** `bind_template` mode, e.g. `uid={username},ou=people,dc=acme,dc=com`. */
  bindTemplate?: string;
  /** `search_bind` mode: where and how to find the entry before binding. */
  searchBaseDn?: string;
  searchFilter?: string;
  serviceBindDn?: string;
  serviceBindSecret?: string;
  /** Stable subject attribute, e.g. `entryUUID` / `objectGUID` — NEVER the DN. */
  subjectAttribute: string;
  attributeMap: OrgLdapAttributeMap;
  /** Group DN/cn → org role. */
  groupRoleMap: Record<string, OrganizationRole>;
}

export type OrgLdapBindMode = "bind_template" | "search_bind";

export interface OrgLdapAttributeMap {
  email?: string;
  name?: string;
}

/** How a bring-your-own upstream's client credentials were obtained. */
export type ByoUpstreamRegistrationSource = "manual" | "dcr";

export type ByoUpstreamState = "active" | "disabled";

export type ByoUpstreamClientAuth = "none" | "client_secret_post";

/**
 * A bring-your-own OIDC upstream a visitor registered at sign-in (ADR 0055):
 * their own issuer plus either credentials they registered themselves or ones
 * RFC 7591 dynamic client registration minted for us.
 *
 * `clientSecret` is held verbatim rather than hashed: it must be presented to
 * the upstream token endpoint as issued, so a digest could never be used. It
 * sits behind the same trust boundary as env-held provider secrets and is
 * never agent-facing.
 */
export interface ByoUpstream {
  id: string;
  /** Trailing-slash-normalized issuer — the record's identity. */
  issuer: string;
  label: string;
  clientId: string;
  clientSecret?: string;
  clientAuth: ByoUpstreamClientAuth;
  registrationSource: ByoUpstreamRegistrationSource;
  state: ByoUpstreamState;
  createdAt: Date;
  lastUsedAt?: Date;
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
  manifest: JsonObject;
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

/** Where a pending authorization request stands (ADR 0046). */
export type AuthorizationRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

/**
 * Who settled a request. An agent-settled decision must never be
 * indistinguishable from one a person made, so the kind is recorded
 * alongside the identity rather than inferred from it.
 */
export type ApprovalDecidedByKind = "human" | "agent";

/**
 * A request waiting for a human (or an envelope-bounded agent) to allow or
 * refuse it — the CIBA-shaped object behind the inbox (ADR 0046).
 *
 * `requestDigest` is what makes an approval mean something: the executor
 * refuses when what it is about to run does not hash to what was approved,
 * so a request cannot be swapped after consent (PSD2 dynamic linking).
 */
export interface AuthorizationRequest {
  /** CIBA `auth_req_id`. Opaque; never derived from the requester. */
  id: string;
  /** The approver — whose authority is being asked for. */
  principalId: PrincipalId;
  /**
   * Who is asking, as an opaque reference rather than a canonical principal
   * id: this travels to inboxes and, later, over public bus subjects.
   */
  requesterRef: string;
  /** RFC 9396 authorization_details: constraint, prompt, and receipt in one shape. */
  authorizationDetails: JsonObject[];
  /** Canonical digest of the exact request being consented to. */
  requestDigest: string;
  /** Short human-readable string shown identically to requester and approver. */
  bindingMessage: string;
  status: AuthorizationRequestStatus;
  /** Poll pacing, in seconds (CIBA `interval`). */
  intervalSeconds: number;
  connectionId?: string;
  delegationId?: string;
  createdAt: Date;
  expiresAt: Date;
  decidedAt?: Date;
  decidedByPrincipalId?: PrincipalId;
  decidedByKind?: ApprovalDecidedByKind;
  version: number;
}

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
  targetManifest: JsonObject;
  /** Immutable after create — never mutate in place. */
  targetManifestDigest: string;
  requestedDestination?: JsonObject;
  requestedGrant?: JsonObject;
  createdAt: Date;
  presentedAt?: Date;
  authenticatedAt?: Date;
  reviewedAt?: Date;
  completedAt?: Date;
  expiresAt: Date;
  revokedAt?: Date;
  completedByPrincipalId?: PrincipalId;
  reviewDecision?: JsonObject;
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
  metadata: JsonObject;
  /** Digest of the preceding event in the trail — tamper evidence, not a signature. */
  previousDigest?: string;
  /** Digest of this event over its own fields and `previousDigest`. */
  digest?: string;
}

export interface WebhookEndpoint {
  id: string;
  principalId: string;
  url: string;
  /** whsec_ signing key. Masked on every surface after registration. */
  secret: string;
  description?: string;
  createdAt: Date;
  disabledAt?: Date;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventType: string;
  payload: JsonObject;
  attempts: number;
  nextAttemptAt: Date;
  deliveredAt?: Date;
  deadAt?: Date;
  lastError?: string;
  createdAt: Date;
}

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: JsonObject;
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

/** Connection lifecycle events the broker emits today (ADR 0032, ADR 0049). */
export type ConnectionDomainEventType =
  | "connection.created"
  | "connection.authorized"
  | "connection.refreshed"
  | "connection.refresh_failed"
  | "connection.bound"
  | "connection.unbound"
  | "connection.materialized"
  | "connection.revoked";

/** Personal project provisioning (WP-B). */
export type ProjectDomainEventType = "project.personal.ensured";

/** Secret/config changelog event types (frozen for WP-C/D/E). */
export type SecretConfigDomainEventType =
  | "secret.config.created"
  | "secret.config.updated"
  | "secret.config.deleted"
  | "secret.value.changed"
  | "secret.value.rolled_back";

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
  | "connection.delegated";

/**
 * Authorization-request lifecycle (ADR 0046). Reserved names promoted to
 * producers by the inbox: a request is announced when it starts waiting and
 * again when somebody settles it.
 */
export type AuthorizationRequestEventType =
  | "authority.invocation.requested"
  | "authority.invocation.completed";

export interface SigningKeyProvider {
  getActiveSigningKeys(): Promise<readonly JsonWebKey[]>;
  getJwks(): Promise<SigningJwks>;
  rotationStatus(): Promise<SigningKeyRotationStatus>;
}

export interface SigningJwks {
  keys: readonly JsonWebKey[];
}

export interface SigningKeyRotationStatus {
  activeKid: string;
  retiringKids: string[];
}

export interface AbuseChallengeInput {
  action: string;
  ip?: string;
  principalId?: string;
  proofKeyJkt?: string;
}

export interface AbuseChallengeResult {
  allowed: boolean;
  retryAfterMs?: number;
  challenge?: string;
}

export interface AbuseChallengeProvider {
  challenge(input: AbuseChallengeInput): Promise<AbuseChallengeResult>;
}

export class NoopAbuseChallengeProvider implements AbuseChallengeProvider {
  async challenge(): Promise<AbuseChallengeResult> {
    return { allowed: true };
  }
}
