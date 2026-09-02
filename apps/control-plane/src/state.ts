import {
  type ClientClaimChallengeStore,
  type ClientOriginStore,
  type ConsentStore,
  type OrgFederationStores,
  type OrganizationMembershipStore,
  type OrganizationStore,
  type OrganizationStores,
  type ProjectMembershipStore,
  type ProjectStore,
  type ProjectStores,
  type SamlStores,
  type ScimStores,
  createMemoryClientClaimChallengeStore,
  createMemoryClientOriginStore,
  createMemoryConsentStore,
  createMemoryOrgFederationStores,
  createMemoryOrganizationStores,
  createMemoryProjectStores,
  createMemorySamlStores,
  createMemoryScimStores,
} from "@opensesame/database";
import {
  type ClientRecordStore,
  MemoryClientRecordStore,
} from "@opensesame/oauth-provider";
import type {
  Agent,
  AgentInstance,
  ProvisionalSession,
} from "@opensesame/os-domain";

export interface IdempotencyRecord {
  status: number;
  body: unknown;
  /** Epoch ms after which the cached response is discarded. */
  expiresAt: number;
}

export interface UsageSnapshot {
  temporaryProjects: number;
  temporaryResources: number;
  agents: number;
  organizations: number;
  oauthClients: number;
  projects: number;
  claims: number;
}

/**
 * A code sent out of band and not yet verified. Only its hash is held: the
 * code itself left with the message, and a memory dump of this process must
 * not be a second way to read it.
 */
export interface MfaCodeChallenge {
  principalId: string;
  channel: "email" | "sms";
  /** Where it went, verbatim — returned masked, never whole. */
  to: string;
  /** sha256(challengeId ":" code), hex. */
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

export interface AppStores {
  provisionalSessions: Map<string, ProvisionalSession>;
  /** session token → session id */
  provisionalTokens: Map<string, string>;
  /**
   * Durable project rows (WP-8). Memory-backed in tests/dev, Postgres when a
   * database is configured — same interface either way.
   */
  projects: ProjectStore;
  /** Durable project memberships, keyed by (projectId, principalId). */
  projectMemberships: ProjectMembershipStore;
  /** project id → tail of serialized membership mutations */
  projectMembershipMutations: Map<string, Promise<void>>;
  /** principalId → active (swapped-in) project id */
  activeProjects: Map<string, string>;
  /**
   * Durable organization rows (ADR 0055). Tenant SSO/SAML configuration lives
   * on this row and is read on the login path, so it cannot stay in process
   * memory: a restart that forgot an org's issuer silently turned enterprise
   * sign-in off. Memory-backed in tests/dev, Postgres when a database is
   * configured — same interface either way.
   */
  organizations: OrganizationStore;
  /** Durable organization memberships, keyed by (organizationId, principalId). */
  organizationMemberships: OrganizationMembershipStore;
  /** organization id → tail of serialized membership mutations */
  organizationMembershipMutations: Map<string, Promise<void>>;
  /**
   * SCIM directory rows and provisioning tokens (ADR 0056). Read on the
   * JIT-join path when an organization marks provisioning authoritative.
   */
  scim: ScimStores;
  /** Org email domains (home-realm discovery) and per-org LDAP configuration. */
  orgFederation: OrgFederationStores;
  /** SAML SP-initiated pending requests and the assertion replay cache. */
  saml: SamlStores;
  /**
   * OAuth client records — the same durable store the OIDC provider resolves
   * clients from (ADR 0050 R-C), never a process-local copy.
   */
  oauthClients: ClientRecordStore;
  /** F5 well-known claim challenges (single-use, short TTL). */
  clientClaimChallenges: ClientClaimChallengeStore;
  /** Verified origin aliases attached to claimed applications. */
  clientOrigins: ClientOriginStore;
  /**
   * Durable human consent records (ADR 0034 §3, ADR 0050 F6): remembered,
   * widening, individually revocable. The oidc-provider Grant decides whether
   * the consent prompt re-appears; this store is the revocable record.
   */
  consents: ConsentStore;
  agents: Map<string, Agent>;
  agentInstances: Map<string, AgentInstance>;
  /** principalId → usage counters */
  usage: Map<
    string,
    { temporaryProjects: number; temporaryResources: number; agents: number }
  >;
  /** Idempotency-Key → response */
  idempotency: Map<string, IdempotencyRecord>;
  /** principalId → base64 TOTP secret */
  totpSecrets: Map<string, string>;
  /** claimId → failed user-code approval attempts (brute-force fence) */
  claimApprovalAttempts: Map<string, number>;
  /** mfa subject → failed verification attempts (brute-force fence) */
  mfaFailures: Map<string, number>;
  /** challengeId → a one-time code sent by email or text, until it is spent */
  mfaCodes: Map<string, MfaCodeChallenge>;
  /** principalId → serialized quota mutations */
  principalMutations: Map<string, Promise<void>>;
  /** Idempotency-Key inflight locks */
  idempotencyLocks: Map<string, Promise<void>>;
  /** client fingerprint → provisional mint timestamps */
  provisionalMints: Map<string, number[]>;
  /** unauthenticated MFA fingerprint → attempt timestamps */
  mfaAnon: Map<string, number[]>;
  /** authentication-service public ceremony fingerprint → request timestamps */
  authenticationAnon: Map<string, number[]>;
  /**
   * Provider-callback fingerprint → request timestamps.
   *
   * A courtesy fence on an unauthenticated route, exactly like `mfaAnon`:
   * what actually defends `/v1/notification-callbacks` is provenance over the
   * raw bytes, the binding lookup and the durable replay ledger. Nothing is
   * refused on security grounds because of this map.
   */
  notificationCallbacks: Map<string, number[]>;
}

export function createAppStores(options?: {
  oauthClients?: ClientRecordStore;
  clientClaimChallenges?: ClientClaimChallengeStore;
  clientOrigins?: ClientOriginStore;
  consents?: ConsentStore;
  projectStores?: ProjectStores;
  organizationStores?: OrganizationStores;
  scimStores?: ScimStores;
  orgFederationStores?: OrgFederationStores;
  samlStores?: SamlStores;
}): AppStores {
  const projectStores = options?.projectStores ?? createMemoryProjectStores();
  const organizationStores =
    options?.organizationStores ?? createMemoryOrganizationStores();
  return {
    provisionalSessions: new Map(),
    provisionalTokens: new Map(),
    projects: projectStores.projects,
    projectMemberships: projectStores.projectMemberships,
    projectMembershipMutations: new Map(),
    activeProjects: new Map(),
    organizations: organizationStores.organizations,
    organizationMemberships: organizationStores.organizationMemberships,
    organizationMembershipMutations: new Map(),
    scim: options?.scimStores ?? createMemoryScimStores(),
    orgFederation:
      options?.orgFederationStores ?? createMemoryOrgFederationStores(),
    saml: options?.samlStores ?? createMemorySamlStores(),
    oauthClients: options?.oauthClients ?? new MemoryClientRecordStore(),
    clientClaimChallenges:
      options?.clientClaimChallenges ?? createMemoryClientClaimChallengeStore(),
    clientOrigins: options?.clientOrigins ?? createMemoryClientOriginStore(),
    consents: options?.consents ?? createMemoryConsentStore(),
    agents: new Map(),
    agentInstances: new Map(),
    usage: new Map(),
    idempotency: new Map(),
    totpSecrets: new Map(),
    claimApprovalAttempts: new Map(),
    mfaFailures: new Map(),
    mfaCodes: new Map(),
    principalMutations: new Map(),
    idempotencyLocks: new Map(),
    provisionalMints: new Map(),
    mfaAnon: new Map(),
    authenticationAnon: new Map(),
    notificationCallbacks: new Map(),
  };
}

/** Project states that still occupy a quota slot. */
const LIVE_PROJECT_STATES = new Set(["provisional", "active"]);
/** Agent states that still occupy a quota slot. */
const LIVE_AGENT_STATES = new Set(["provisional", "claimed", "suspended"]);
/** Organization states that still occupy a quota slot. */
const LIVE_ORGANIZATION_STATES = new Set([
  "provisional",
  "active",
  "suspended",
]);
/** OAuth client states that still occupy a quota slot. */
const LIVE_OAUTH_CLIENT_STATES = new Set(["active", "suspended"]);

/**
 * Live quota usage for a principal.
 *
 * Projects, agents, organizations and OAuth clients are counted from the stores
 * rather than from a running total: a cumulative counter turns a quota into a
 * lifetime cap, so a provisional principal stayed blocked after three temporary
 * projects even once they had all expired. Resources have no store yet and keep
 * the counter.
 */
export async function getUsage(
  stores: AppStores,
  principalId: string,
  now: Date = new Date(),
): Promise<UsageSnapshot> {
  let temporaryProjects = 0;
  let projects = 0;
  for (const project of await stores.projects.listByOwner(principalId)) {
    if (!LIVE_PROJECT_STATES.has(project.state)) continue;
    if (project.expiresAt && project.expiresAt <= now) continue;
    // The always-present personal project never spends a quota slot.
    if (project.kind === "personal") continue;
    if (project.kind === "temporary") temporaryProjects += 1;
    else projects += 1;
  }

  let agents = 0;
  for (const agent of stores.agents.values()) {
    if (agent.ownerPrincipalId !== principalId) continue;
    if (!LIVE_AGENT_STATES.has(agent.state)) continue;
    agents += 1;
  }

  let organizations = 0;
  for (const org of await stores.organizations.listByCreator(principalId)) {
    if (!LIVE_ORGANIZATION_STATES.has(org.state)) continue;
    organizations += 1;
  }

  let oauthClients = 0;
  for (const client of await stores.oauthClients.listByOwner(principalId)) {
    if (!LIVE_OAUTH_CLIENT_STATES.has(client.state)) continue;
    oauthClients += 1;
  }

  return {
    temporaryProjects,
    temporaryResources: stores.usage.get(principalId)?.temporaryResources ?? 0,
    agents,
    organizations,
    oauthClients,
    projects,
    claims: 0,
  };
}

/**
 * Record resource usage that has no store to count from.
 *
 * Projects and agents are deliberately not bumped here — they are derived from
 * `stores.projects` / `stores.agents`, so a counter would drift from reality and
 * never come back down.
 */
export function bumpUsage(
  stores: AppStores,
  principalId: string,
  patch: { temporaryResources: number },
): void {
  const current = stores.usage.get(principalId);
  stores.usage.set(principalId, {
    temporaryProjects: 0,
    temporaryResources:
      (current?.temporaryResources ?? 0) + patch.temporaryResources,
    agents: 0,
  });
}
