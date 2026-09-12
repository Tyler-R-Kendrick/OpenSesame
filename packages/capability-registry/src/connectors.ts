import type { Capability, CapabilityExclusion } from "./index.js";

const ADR_CONNECTOR_DIRECTORY = "0115-front-door-and-connector-directory.md";

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
