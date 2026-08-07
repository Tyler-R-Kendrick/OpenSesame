import type { AssuranceLevel, Principal } from "@opensesame/os-domain";
import { isProvisionalPrincipal } from "@opensesame/os-domain";

/**
 * Authorization request / decision interfaces.
 *
 * Future AuthZEN seam: map these shapes to OpenID AuthZEN Evaluation API
 * request/response when an external PDP is configured. Keep this module as
 * the PEP-facing contract so AuthZEN can be swapped in without rewriting
 * callers.
 * @see https://openid.net/specs/authorization-api-1_0.html
 */

export interface AuthorizationRequest {
  subject: {
    type: "principal" | "agent" | "client";
    id: string;
    assurance?: AssuranceLevel;
  };
  action: string;
  resource: {
    type: string;
    id: string;
    organizationId?: string;
    projectId?: string;
  };
  context?: Record<string, unknown>;
}

export type DecisionEffect = "allow" | "deny";

export interface AuthorizationDecision {
  effect: DecisionEffect;
  reasons: string[];
  obligations?: string[];
  /** Optional AuthZEN-compatible evaluation id for correlation. */
  evaluationId?: string;
}

export interface ProvisionalQuota {
  maxTemporaryProjects: number;
  maxTemporaryResources: number;
  maxAgents: number;
}

export const DEFAULT_PROVISIONAL_QUOTA: ProvisionalQuota = {
  maxTemporaryProjects: 3,
  maxTemporaryResources: 10,
  maxAgents: 2,
};

const HIGH_RISK_ACTIONS = new Set([
  "organization.delete",
  "principal.merge",
  "grant.export_raw_credential",
  "admin.impersonate",
  "oauth.client.register_privileged",
  "claim.force_complete",
]);

const PROVISIONAL_ALLOWED = new Set([
  "project.create_temporary",
  "resource.create_temporary",
  "resource.read",
  "claim.create",
  "agent.register_ephemeral",
  "session.continue_anonymous",
]);

export interface ProvisionalUsage {
  temporaryProjects: number;
  temporaryResources: number;
  agents: number;
}

export class ProvisionalPolicy {
  constructor(
    private readonly quota: ProvisionalQuota = DEFAULT_PROVISIONAL_QUOTA,
  ) {}

  evaluate(
    principal: Principal,
    request: AuthorizationRequest,
    usage: ProvisionalUsage = {
      temporaryProjects: 0,
      temporaryResources: 0,
      agents: 0,
    },
  ): AuthorizationDecision {
    if (!isProvisionalPrincipal(principal)) {
      // Non-provisional principals are out of scope for this policy module.
      return { effect: "allow", reasons: ["not_provisional"] };
    }

    if (HIGH_RISK_ACTIONS.has(request.action)) {
      return {
        effect: "deny",
        reasons: ["provisional_denies_high_risk", request.action],
      };
    }

    if (!PROVISIONAL_ALLOWED.has(request.action)) {
      return {
        effect: "deny",
        reasons: ["provisional_action_not_permitted", request.action],
      };
    }

    if (
      request.action === "project.create_temporary" &&
      usage.temporaryProjects >= this.quota.maxTemporaryProjects
    ) {
      return {
        effect: "deny",
        reasons: ["provisional_quota_projects"],
        obligations: ["upgrade_identity"],
      };
    }

    if (
      request.action === "resource.create_temporary" &&
      usage.temporaryResources >= this.quota.maxTemporaryResources
    ) {
      return {
        effect: "deny",
        reasons: ["provisional_quota_resources"],
        obligations: ["upgrade_identity"],
      };
    }

    if (
      request.action === "agent.register_ephemeral" &&
      usage.agents >= this.quota.maxAgents
    ) {
      return {
        effect: "deny",
        reasons: ["provisional_quota_agents"],
        obligations: ["upgrade_identity"],
      };
    }

    return {
      effect: "allow",
      reasons: ["provisional_policy_allow"],
    };
  }
}
