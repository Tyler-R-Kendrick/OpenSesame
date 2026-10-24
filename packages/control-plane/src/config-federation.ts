import {
  loadProviderRegistry,
  mergeProviderIssuers,
  normalizeIssuer,
} from "./interactions/registry.js";
import { parseOrganizationIssuerAssignments } from "./organization-issuer-assignments.js";

/** Parse operator federation trust sources before serving any sign-in. */
export function loadFederationConfig(env: NodeJS.ProcessEnv) {
  const providers = loadProviderRegistry(env);
  return {
    providers,
    trustedUpstreamIssuers: mergeProviderIssuers(
      (env.OPENSESAME_TRUSTED_UPSTREAMS ?? "")
        .split(",")
        .map((issuer) => normalizeIssuer(issuer.trim()))
        .filter(Boolean),
      providers,
    ),
    organizationIssuerAssignments: parseOrganizationIssuerAssignments(
      env.OPENSESAME_ORGANIZATION_ISSUER_ASSIGNMENTS,
    ),
  };
}
