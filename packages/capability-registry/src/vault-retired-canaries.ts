import type { Capability, CapabilityExclusion } from "./types.js";
const ADR =
  "0207-retired-credentials-and-controlled-canaries-are-owner-ceremonies.md";
const OWNER_ONLY: CapabilityExclusion = {
  reason:
    "retired credentials and canary signing custody are managed only by a freshly authenticated local owner with configured factors; agent tools never accept primary secrets, arm traps, remove detection or export canary bearers",
  adr: ADR,
};
const OTHER_LOCAL_PRODUCT: CapabilityExclusion = {
  reason:
    "the extension runner navigates to the actual vault security page and shares no vault root; Android and iOS are OpenID4VC authenticators, not the password-vault product",
  adr: ADR,
};
const SERVICE_ONLY: CapabilityExclusion = {
  reason:
    "binding a private loopback receiver and maintaining its authenticated filesystem state is a local Node CLI service, not a browser, extension, mobile wallet or agent operation",
  adr: ADR,
};
const ownerExcluded = {
  mcp_host: OWNER_ONLY,
  mcp_client: OWNER_ONLY,
  webmcp: OWNER_ONLY,
  extension: OTHER_LOCAL_PRODUCT,
  android: OTHER_LOCAL_PRODUCT,
};
export const retiredCanaryCapabilities: readonly Capability[] = [
  {
    id: "vault.retired_credentials.manage",
    title:
      "Fresh-owner retired-password inspection, consented enrollment, removal and activity cleanup",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id vault retired",
      pwa: "route:/settings/security",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
      extension: null,
      android: null,
    },
    excluded: ownerExcluded,
  },
  {
    id: "vault.agent_canaries.manage",
    title:
      "Fresh-owner pairing, inspection, consented detection-only canary enrollment, removal and configuration export",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id vault canary",
      pwa: "route:/settings/security",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
      extension: null,
      android: null,
    },
    excluded: ownerExcluded,
  },
  {
    id: "vault.agent_canaries.serve",
    title: "Run an explicitly paired, detection-only local canary receiver",
    plane: "client_local",
    kind: "admin",
    surfaces: {
      cli: "opensesame-id security canary serve",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
      extension: null,
      android: null,
    },
    excluded: {
      ...ownerExcluded,
      pwa: SERVICE_ONLY,
      extension: SERVICE_ONLY,
      android: SERVICE_ONLY,
    },
  },
];
