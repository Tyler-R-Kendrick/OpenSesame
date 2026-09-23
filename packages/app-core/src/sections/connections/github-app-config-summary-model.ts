import { overlapCast } from "@opensesame/os-domain";
/**
 * View-model logic for `GithubAppConfigSummary` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import type { Connection } from "../../lib/connections.js";

/** App-only bind path when no OAuth connection card is mounted. */
export function localAppConnection(accountLabel: string | null): Connection {
  return overlapCast({
    connectionId: "local-github-app",
    connectionRef: "local-github-app",
    logicalName: "github",
    displayName: "GitHub",
    providerId: "github",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "local",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel,
    expiresAt: null,
    refreshable: false,
    lastRefreshedAt: null,
    maxInvokeLevel: 1,
    egress: {
      scheme: "https",
      authorities: ["api.github.com"],
      pathPrefixes: [],
    },
    bindings: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  }) satisfies Connection;
}
