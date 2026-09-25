import type { Capability, CapabilityExclusion } from "./index.js";

const ADR_CONNECTOR_DIRECTORY = "0115-front-door-and-connector-directory.md";
const ADR_CONNECTOR_PLANS = "0146-connector-plans-and-user-token-proof.md";

const CLIENT_REGISTRATION_IS_HUMAN: CapabilityExclusion = {
  reason:
    "creating or editing a connector registers an OAuth client or pastes a secret under the relay's management key; an agent surface that could do it could re-aim where people's tokens are minted",
  adr: ADR_CONNECTOR_PLANS,
};

const CONSENT_IS_HUMAN: CapabilityExclusion = {
  reason:
    "authorizing a connector is the person's own consent at the provider, in their browser; an agent can ask for it through an interaction, never perform it",
  adr: ADR_CONNECTOR_PLANS,
};

const PROOF_IS_OPERATOR_ONLY: CapabilityExclusion = {
  reason:
    "the proof spends the relay's management key to acquire a real token; it answers metadata only, and stays with the person who holds that key",
  adr: ADR_CONNECTOR_PLANS,
};

const DIRECTORY_KEY_IS_A_CREDENTIAL: CapabilityExclusion = {
  reason:
    "the directory's key is a credential a person types, and pointing this device at an endpoint is how connectors arrive; an agent surface that could do either would be a way to plant connectors",
  adr: ADR_CONNECTOR_DIRECTORY,
};

const BINDING_IS_THE_PAM_DECISION: CapabilityExclusion = {
  reason:
    "binding is the PAM decision itself — who may use which connector, under which policy, until when — and stays with the human custodian of the vault",
  adr: ADR_CONNECTOR_DIRECTORY,
};

/**
 * Connectors by reference (ADR 0115): a Nango-compatible directory read for
 * its listings, sealed into the vault, and bound to local identities through
 * the same share-grant ledger Identity shares use. Both are client-local
 * ceremonies; neither reaches an agent surface.
 */
export const connectorDirectoryCapabilities: readonly Capability[] = [
  {
    id: "connectors.directory.sync",
    title: "Sync authorized connectors from a Nango-compatible directory",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/connector-directory.ts:syncConnectorDirectory",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: DIRECTORY_KEY_IS_A_CREDENTIAL },
  },
  {
    id: "connectors.bind",
    title: "Bind a connector to a local identity under a policy",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/local-share-grants.ts:createLocalShare",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: BINDING_IS_THE_PAM_DECISION },
  },
];

/**
 * Connectors on Vercel Connect, built from their plans (ADR 0146): created
 * with their whole OAuth / MCP / API-key configuration, authorized by a
 * person for themselves, and proven by acquiring that person's token on the
 * relay — which answers a fingerprint and the service's own verdict, never
 * the token.
 */
export const connectPlanCapabilities: readonly Capability[] = [
  {
    id: "connectors.connect.configure",
    title: "Create or edit a connector from its plan",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vercel-connect-manage.ts:createConfiguredConnector",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: CLIENT_REGISTRATION_IS_HUMAN },
  },
  {
    id: "connectors.connect.authorize_user",
    title: "Authorize a connector on behalf of the signed-in person",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vercel-connect-manage.ts:authorizeConnectorAs",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: CONSENT_IS_HUMAN },
  },
  {
    id: "connectors.connect.token_check",
    title: "Prove a person's connector token can be acquired",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vercel-connect-manage.ts:checkConnectorToken",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: PROOF_IS_OPERATOR_ONLY },
  },
];

/** Every connector capability, directory and plans alike. */
export const connectorCapabilities: readonly Capability[] = [
  ...connectorDirectoryCapabilities,
  ...connectPlanCapabilities,
];
