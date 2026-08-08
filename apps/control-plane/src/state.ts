import type {
  Agent,
  AgentInstance,
  OAuthClientRecord,
  Organization,
  Project,
  ProvisionalSession,
} from "@opensesame/os-domain";

export interface IdempotencyRecord {
  status: number;
  body: unknown;
  /** Epoch ms after which the cached response is discarded. */
  expiresAt: number;
}

export interface AppStores {
  provisionalSessions: Map<string, ProvisionalSession>;
  /** session token → session id */
  provisionalTokens: Map<string, string>;
  projects: Map<string, Project>;
  organizations: Map<string, Organization>;
  /** slug → organization id */
  organizationSlugs: Map<string, string>;
  oauthClients: Map<string, OAuthClientRecord>;
  agents: Map<string, Agent>;
  agentInstances: Map<string, AgentInstance>;
  /** principalId → usage counters */
  usage: Map<string, { temporaryProjects: number; temporaryResources: number; agents: number }>;
  /** Idempotency-Key → response */
  idempotency: Map<string, IdempotencyRecord>;
  /** principalId → base64 TOTP secret */
  totpSecrets: Map<string, string>;
  /** claimId → failed user-code approval attempts (brute-force fence) */
  claimApprovalAttempts: Map<string, number>;
  /** mfa subject → failed verification attempts (brute-force fence) */
  mfaFailures: Map<string, number>;
}

export function createAppStores(): AppStores {
  return {
    provisionalSessions: new Map(),
    provisionalTokens: new Map(),
    projects: new Map(),
    organizations: new Map(),
    organizationSlugs: new Map(),
    oauthClients: new Map(),
    agents: new Map(),
    agentInstances: new Map(),
    usage: new Map(),
    idempotency: new Map(),
    totpSecrets: new Map(),
    claimApprovalAttempts: new Map(),
    mfaFailures: new Map(),
  };
}

/** Project states that still occupy a quota slot. */
const LIVE_PROJECT_STATES = new Set(["provisional", "active"]);
/** Agent states that still occupy a quota slot. */
const LIVE_AGENT_STATES = new Set(["provisional", "claimed", "suspended"]);
/** Organization states that still occupy a quota slot. */
const LIVE_ORGANIZATION_STATES = new Set(["provisional", "active", "suspended"]);
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
export function getUsage(
  stores: AppStores,
  principalId: string,
  now: Date = new Date(),
): {
  temporaryProjects: number;
  temporaryResources: number;
  agents: number;
  organizations: number;
  oauthClients: number;
} {
  let temporaryProjects = 0;
  for (const project of stores.projects.values()) {
    if (project.ownerPrincipalId !== principalId) continue;
    if (!LIVE_PROJECT_STATES.has(project.state)) continue;
    if (project.expiresAt && project.expiresAt <= now) continue;
    temporaryProjects += 1;
  }

  let agents = 0;
  for (const agent of stores.agents.values()) {
    if (agent.ownerPrincipalId !== principalId) continue;
    if (!LIVE_AGENT_STATES.has(agent.state)) continue;
    agents += 1;
  }

  let organizations = 0;
  for (const org of stores.organizations.values()) {
    if (org.createdBy !== principalId) continue;
    if (!LIVE_ORGANIZATION_STATES.has(org.state)) continue;
    organizations += 1;
  }

  let oauthClients = 0;
  for (const client of stores.oauthClients.values()) {
    if (client.ownerPrincipalId !== principalId) continue;
    if (!LIVE_OAUTH_CLIENT_STATES.has(client.state)) continue;
    oauthClients += 1;
  }

  return {
    temporaryProjects,
    temporaryResources: stores.usage.get(principalId)?.temporaryResources ?? 0,
    agents,
    organizations,
    oauthClients,
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
