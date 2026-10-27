import type { AuthorityGrant } from "@opensesame/os-domain";
import { fixedGrants, resetAudience, resetResource } from "./grants.js";
import {
  type Observation,
  RESET_ACTIONS,
  type ResetAction,
  type ResetRun,
} from "./types.js";

export const ORIGIN = "https://accounts.example.test";

export function observation(fields: Observation["fields"] = []): Observation {
  return { id: "observation-1", origin: ORIGIN, fields };
}

export function run(): ResetRun {
  return {
    id: "run-1",
    domain: "accounts.example.test",
    origin: ORIGIN,
    itemId: "item-1",
    transport: "cdp",
    grantIds: Object.fromEntries(
      RESET_ACTIONS.map((action) => [action, `grant:${action}`]),
    ),
    cursor: 0,
    status: "running",
    updatedAt: "2026-10-27T00:00:00.000Z",
    recipe: {
      schemaVersion: 1,
      review: "approved",
      domain: "accounts.example.test",
      entryPath: "/login",
      allowedOrigins: [ORIGIN],
      steps: [
        { id: "open", primitive: "navigate", path: "/login" },
        {
          id: "identify",
          primitive: "fill-field",
          ref: "e1",
          purpose: "identifier",
        },
        { id: "request", primitive: "click", ref: "e2" },
        { id: "mail", primitive: "await-email-link" },
        {
          id: "password",
          primitive: "fill-field",
          ref: "e3",
          purpose: "new-password",
        },
        { id: "submit", primitive: "submit", ref: "e4" },
        { id: "verify", primitive: "verify-login" },
      ],
    },
  };
}

export function grant(
  action: ResetAction = "password_reset.browser.drive",
  now = new Date("2026-10-27T00:00:00.000Z"),
): AuthorityGrant {
  return {
    id: `grant:${action}`,
    version: 1,
    issuerPrincipalId: "person",
    beneficiaryPrincipalId: "agent",
    actorId: null,
    clientId: null,
    actorInstanceId: "agent-instance-1",
    proofKeyThumbprint: "proof-key-1",
    organizationId: "org",
    projectId: null,
    environmentId: null,
    connectionId: null,
    actions: [action],
    resources: [resetResource("accounts.example.test", "item-1")],
    constraints: {
      audiences: [resetAudience("run-1")],
      notBefore: null,
      expiresAt: new Date(now.getTime() + 60_000),
      requiredAssurance: null,
      authenticationMaxAgeSeconds: null,
      allowedNetworks: [],
      parameterRulesDigest: null,
      budgets: {},
      maximumDelegationDepth: 0,
      offlineUse: "forbidden",
      rawCredentialExport: false,
    },
    parentGrantId: null,
    delegationDepth: 0,
    createdAt: now,
    revokedAt: null,
  };
}

export function grants() {
  return fixedGrants(
    Object.fromEntries(RESET_ACTIONS.map((action) => [action, grant(action)])),
  );
}
