import type { Capability, CapabilityExclusion } from "./index.js";

const BROWSER: CapabilityExclusion = {
  reason:
    "Browser pairing and verified user authority require an explicit human ceremony; an agent cannot approve its own origin, key or elevation",
  adr: "0094-browser-local-authority.md",
};

const AGENT: CapabilityExclusion = {
  reason:
    "Native approval and revocation define the agent ceiling; agents cannot mint or administer their own authority",
  adr: "0099-scoped-local-agent-authority.md",
};

const KDF: CapabilityExclusion = {
  reason:
    "Offline wrapper inspection and migration belong to the human device owner; migration handles vault keys and requires explicit confirmation",
  adr: "0097-bounded-kdf-policy.md",
};

const METADATA: CapabilityExclusion = {
  reason:
    "Project metadata policy and membership ceilings require the human role and resource authorization boundary, not an agent administration tool",
  adr: "0098-secret-metadata-authorization.md",
};

export const securityAuthorityCapabilities: readonly Capability[] = [
  {
    id: "browser.pairing.begin",
    title: "Request an origin and proof-key bound browser pairing",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/browser-pairing.ts:beginBrowserPairing",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: BROWSER, mcp_client: BROWSER, webmcp: BROWSER },
  },
  {
    id: "browser.pairing.inspect",
    title: "Inspect the exact pending browser pairing in a native ceremony",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame local-authority pair",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: BROWSER, mcp_client: BROWSER, webmcp: BROWSER },
  },
  {
    id: "browser.pairing.decide",
    title: "Approve or deny an origin-bound browser pairing",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame local-authority pair",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: BROWSER, mcp_client: BROWSER, webmcp: BROWSER },
  },
  {
    id: "browser.identity.authenticate",
    title: "Bind verified Identity evidence to the paired browser",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/host-authorization.ts:authenticateBrowser",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: BROWSER, mcp_client: BROWSER, webmcp: BROWSER },
  },
  {
    id: "browser.client.revoke",
    title: "Revoke a paired browser and its active grants",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "lib/browser-pairing.ts:revokeBrowserPairing",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: BROWSER, mcp_client: BROWSER, webmcp: BROWSER },
  },
  {
    id: "agent.launch.approve",
    title: "Approve and launch an audience-scoped local agent",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame local-authority launch",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: AGENT, mcp_client: AGENT, webmcp: AGENT },
  },
  {
    id: "agent.capability.revoke",
    title: "Revoke scoped agent grants through native Host administration",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: AGENT, mcp_client: AGENT, webmcp: AGENT },
  },
  {
    id: "vault.wrapper.inspect",
    title: "Inspect local password-wrapper parameters without deriving a key",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame vault-inspect",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: KDF, mcp_client: KDF, webmcp: KDF },
  },
  {
    id: "vault.wrapper.migrate",
    title: "Interactively migrate a local wrapper to the portable KDF policy",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame vault-migrate",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: KDF, mcp_client: KDF, webmcp: KDF },
  },
  {
    id: "sync.legacy.rebind",
    title:
      "Rebind explicitly selected legacy ciphertext with ownership evidence",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame sync rebind-legacy",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: BROWSER, mcp_client: BROWSER, webmcp: BROWSER },
  },
  {
    id: "configs.permissions.read",
    title: "Read effective project metadata and key-name permissions",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "lib/secret-config-access.ts:loadConfigAccess",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: METADATA, mcp_client: METADATA, webmcp: METADATA },
  },
  {
    id: "configs.permissions.write",
    title: "Set project metadata permissions within the current Host ceiling",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: METADATA, mcp_client: METADATA, webmcp: METADATA },
  },
  {
    id: "configs.membership.manage",
    title: "Set or revoke native Host organization role ceilings",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: METADATA, mcp_client: METADATA, webmcp: METADATA },
  },
];
