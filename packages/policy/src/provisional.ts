import type {
  AssuranceLevel,
  JsonObject,
  Principal,
} from "@opensesame/os-domain";
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
  context?: JsonObject;
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
  maxOrganizations: number;
  maxOAuthClients: number;
  /** Persistent (non-temporary, non-personal) projects a principal may own. */
  maxProjects: number;
  /** Live (non-terminal) claims a principal may hold. */
  maxClaims: number;
}

/**
 * A provisional principal may not create organizations or OAuth clients at all,
 * so these limits are zero rather than absent — an unlisted action would spend
 * nothing and be capped by nothing.
 */
export const DEFAULT_PROVISIONAL_QUOTA: ProvisionalQuota = {
  maxTemporaryProjects: 3,
  maxTemporaryResources: 10,
  maxAgents: 2,
  maxOrganizations: 0,
  maxOAuthClients: 0,
  maxProjects: 3,
  maxClaims: 8,
};

/**
 * Verified principals get a larger allowance, not an unlimited one: assurance
 * says who someone is, it does not say they may mint resources forever.
 */
export const DEFAULT_VERIFIED_QUOTA: ProvisionalQuota = {
  maxTemporaryProjects: 50,
  maxTemporaryResources: 500,
  maxAgents: 25,
  maxOrganizations: 10,
  maxOAuthClients: 25,
  maxProjects: 25,
  maxClaims: 64,
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
  "project.create",
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
  organizations: number;
  oauthClients: number;
  projects: number;
  claims: number;
}

/** Which quota field, if any, a given action spends. */
function quotaFieldFor(action: string): {
  usage: keyof ProvisionalUsage;
  limit: keyof ProvisionalQuota;
  reason: string;
} | null {
  switch (action) {
    case "project.create_temporary":
      return {
        usage: "temporaryProjects",
        limit: "maxTemporaryProjects",
        reason: "quota_projects",
      };
    case "resource.create_temporary":
      return {
        usage: "temporaryResources",
        limit: "maxTemporaryResources",
        reason: "quota_resources",
      };
    case "agent.register_ephemeral":
      return { usage: "agents", limit: "maxAgents", reason: "quota_agents" };
    case "organization.create":
      return {
        usage: "organizations",
        limit: "maxOrganizations",
        reason: "quota_organizations",
      };
    case "project.create":
      return {
        usage: "projects",
        limit: "maxProjects",
        reason: "quota_projects",
      };
    case "oauth.client.register":
      return {
        usage: "oauthClients",
        limit: "maxOAuthClients",
        reason: "quota_oauth_clients",
      };
    case "claim.create":
      return { usage: "claims", limit: "maxClaims", reason: "quota_claims" };
    // Stryker disable next-line ConditionalExpression: equivalent — dropping the
    // default returns undefined instead of null, and the caller only tests it
    // for truthiness.
    default:
      return null;
  }
}

export class ProvisionalPolicy {
  constructor(
    private readonly quota: ProvisionalQuota = DEFAULT_PROVISIONAL_QUOTA,
    private readonly verifiedQuota: ProvisionalQuota = DEFAULT_VERIFIED_QUOTA,
  ) {}

  evaluate(
    principal: Principal,
    request: AuthorizationRequest,
    usage: ProvisionalUsage = {
      temporaryProjects: 0,
      temporaryResources: 0,
      agents: 0,
      organizations: 0,
      oauthClients: 0,
      projects: 0,
      claims: 0,
    },
  ): AuthorizationDecision {
    // High-risk actions are denied for every subject. Nothing in this system
    // grants them yet, and a PEP that answers "allow" because it has no rule is
    // worse than no PEP at all.
    if (HIGH_RISK_ACTIONS.has(request.action)) {
      return {
        effect: "deny",
        reasons: ["high_risk_requires_explicit_authority", request.action],
      };
    }

    const provisional = isProvisionalPrincipal(principal);
    if (provisional && !PROVISIONAL_ALLOWED.has(request.action)) {
      return {
        effect: "deny",
        reasons: ["provisional_action_not_permitted", request.action],
      };
    }

    const spend = quotaFieldFor(request.action);
    if (spend) {
      const quota = provisional ? this.quota : this.verifiedQuota;
      if (usage[spend.usage] >= quota[spend.limit]) {
        const denial: AuthorizationDecision = {
          effect: "deny",
          reasons: provisional
            ? [`provisional_${spend.reason}`, spend.reason]
            : [spend.reason],
        };
        // Only a provisional principal can clear the denial by upgrading.
        if (provisional) {
          denial.obligations = ["upgrade_identity"];
        }
        return denial;
      }
    }

    return {
      effect: "allow",
      reasons: [
        provisional ? "provisional_policy_allow" : "assurance_not_provisional",
      ],
    };
  }
}
