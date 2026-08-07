import type {
  Agent,
  AgentInstance,
  Project,
  ProvisionalSession,
} from "@opensesame/os-domain";

export interface IdempotencyRecord {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface AppStores {
  provisionalSessions: Map<string, ProvisionalSession>;
  /** session token → session id */
  provisionalTokens: Map<string, string>;
  projects: Map<string, Project>;
  agents: Map<string, Agent>;
  agentInstances: Map<string, AgentInstance>;
  /** principalId → usage counters */
  usage: Map<string, { temporaryProjects: number; temporaryResources: number; agents: number }>;
  /** Idempotency-Key → response */
  idempotency: Map<string, IdempotencyRecord>;
}

export function createAppStores(): AppStores {
  return {
    provisionalSessions: new Map(),
    provisionalTokens: new Map(),
    projects: new Map(),
    agents: new Map(),
    agentInstances: new Map(),
    usage: new Map(),
    idempotency: new Map(),
  };
}

export function getUsage(
  stores: AppStores,
  principalId: string,
): { temporaryProjects: number; temporaryResources: number; agents: number } {
  return (
    stores.usage.get(principalId) ?? {
      temporaryProjects: 0,
      temporaryResources: 0,
      agents: 0,
    }
  );
}

export function bumpUsage(
  stores: AppStores,
  principalId: string,
  patch: Partial<{
    temporaryProjects: number;
    temporaryResources: number;
    agents: number;
  }>,
): void {
  const current = getUsage(stores, principalId);
  stores.usage.set(principalId, {
    temporaryProjects:
      current.temporaryProjects + (patch.temporaryProjects ?? 0),
    temporaryResources:
      current.temporaryResources + (patch.temporaryResources ?? 0),
    agents: current.agents + (patch.agents ?? 0),
  });
}
