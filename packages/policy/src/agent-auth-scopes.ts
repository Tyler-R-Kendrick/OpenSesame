import type { Principal } from "@opensesame/os-domain";
import type {
  AuthorizationDecision,
  ProvisionalPolicy,
  ProvisionalUsage,
} from "./provisional.js";

/**
 * Protocol-facing scopes for auth.md AgentAuth. These are not domain actions;
 * {@link AGENT_AUTH_SCOPE_ACTIONS} maps each scope onto policy actions.
 */
export const AGENT_AUTH_SCOPES = [
  "resource:read",
  "resource:create:temporary",
  "project:create:temporary",
  "claim:create",
] as const;

export type AgentAuthScope = (typeof AGENT_AUTH_SCOPES)[number];

export const DEFAULT_PRE_CLAIM_SCOPES: readonly AgentAuthScope[] = [
  "resource:read",
  "resource:create:temporary",
];

export const DEFAULT_POST_CLAIM_SCOPES: readonly AgentAuthScope[] = [
  "resource:read",
  "resource:create:temporary",
  "project:create:temporary",
  "claim:create",
];

export const AGENT_AUTH_SCOPE_ACTIONS: Readonly<
  Record<AgentAuthScope, string>
> = {
  "resource:read": "resource.read",
  "resource:create:temporary": "resource.create_temporary",
  "project:create:temporary": "project.create_temporary",
  "claim:create": "claim.create",
};

export const AGENT_AUTH_SCOPE_DESCRIPTIONS: Readonly<
  Record<AgentAuthScope, string>
> = {
  "resource:read": "Read resources the registration is allowed to see",
  "resource:create:temporary": "Create TTL-bound temporary resources",
  "project:create:temporary": "Create a TTL-bound temporary project",
  "claim:create": "Create a claim session for later human confirmation",
};

export function isAgentAuthScope(value: string): value is AgentAuthScope {
  return (AGENT_AUTH_SCOPES as readonly string[]).includes(value);
}

export function parseScopeParameter(
  scope: string | undefined,
): string[] | undefined {
  if (scope === undefined || scope.trim() === "") return undefined;
  return scope.split(/[\s+]+/).filter(Boolean);
}

/**
 * Intersection, never union:
 * requested ∩ registration-state ∩ resource-supported ∩ policy.
 */
export function intersectAgentAuthScopes(parts: {
  requested?: readonly string[];
  registration: readonly string[];
  resourceSupported?: readonly string[];
}): string[] {
  const registration = new Set(parts.registration);
  const resource = parts.resourceSupported
    ? new Set(parts.resourceSupported)
    : null;
  const requested = parts.requested ?? parts.registration;
  const out: string[] = [];
  for (const scope of requested) {
    if (!registration.has(scope)) continue;
    if (resource && !resource.has(scope)) continue;
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

export function scopesForRegistrationState(input: {
  claimed: boolean;
  preClaimScopes: readonly string[];
  postClaimScopes: readonly string[];
}): string[] {
  return [...(input.claimed ? input.postClaimScopes : input.preClaimScopes)];
}

export function evaluateAgentAuthScopes(
  policy: ProvisionalPolicy,
  principal: Principal,
  scopes: readonly string[],
  usage?: ProvisionalUsage,
): { allowed: string[]; denied: string[]; decisions: AuthorizationDecision[] } {
  const allowed: string[] = [];
  const denied: string[] = [];
  const decisions: AuthorizationDecision[] = [];
  for (const scope of scopes) {
    if (!isAgentAuthScope(scope)) {
      denied.push(scope);
      decisions.push({
        effect: "deny",
        reasons: ["unknown_scope", scope],
      });
      continue;
    }
    const action = AGENT_AUTH_SCOPE_ACTIONS[scope];
    const decision = policy.evaluate(
      principal,
      {
        subject: {
          type: "principal",
          id: principal.id,
          assurance: principal.assurance,
        },
        action,
        resource: { type: "agent_registration", id: principal.id },
      },
      usage,
    );
    decisions.push(decision);
    if (decision.effect === "allow") allowed.push(scope);
    else denied.push(scope);
  }
  return { allowed, denied, decisions };
}
