import { NEVER_AGENT_SECRET } from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./types.js";

export const ADR = "0177-password-workflow-surface-boundaries.md";
export const NO_CUSTODY: CapabilityExclusion = {
  reason:
    "Host MCP has custody of neither a native provider session nor the unlocked browser vault; real metadata operations run in Pages WebMCP",
  adr: ADR,
};
export const HANDOFF: CapabilityExclusion = {
  reason:
    "the extension keeps its own sealed candidates and origin grants (ADR 0076); these workflows run in the PWA's item pages and Password health, which the extension neither opens nor reads",
  adr: ADR,
};
export const WALLET_ONLY: CapabilityExclusion = {
  reason:
    "native authenticator applications are OpenID4VC wallets with neither a password-provider session nor the browser vault; mobile users use the PWA",
  adr: ADR,
};
export const NATIVE_ONLY: CapabilityExclusion = {
  reason:
    "requires native provider custody, local process execution, files or OS credential storage; browser users operate on their own vault instead",
  adr: ADR,
};

/** Shared workflows use the native provider on CLI and the browser vault on Pages. */
export const passwordWorkflowCapabilities: readonly Capability[] = [
  {
    id: "vault.workflow.find_references",
    title: "Find references by title queries",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame-id find",
      pwa: "route:/vault",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_vault_find_references",
    },
    excluded: {
      mcp_host: NO_CUSTODY,
      mcp_client: NO_CUSTODY,

      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "vault.workflow.inventory",
    title: "Inspect metadata-only credential inventory",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame-id inventory",
      pwa: "lib/vault/password-workflows.ts:passwordWorkflowInventory",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_vault_inventory",
    },
    excluded: {
      mcp_host: NO_CUSTODY,
      mcp_client: NO_CUSTODY,

      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "vault.workflow.audit_organization",
    title: "Audit credential organization without values",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame-id audit",
      pwa: "lib/vault/password-workflows.ts:passwordWorkflowAudit",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_vault_audit_organization",
    },
    excluded: {
      mcp_host: NO_CUSTODY,
      mcp_client: NO_CUSTODY,

      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "vault.workflow.env_template",
    title: "Build reference-only environment templates",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame-id env write",
      pwa: "lib/vault/item-references.ts:itemEnvTemplate",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_vault_env_template",
    },
    excluded: {
      mcp_host: NO_CUSTODY,
      mcp_client: NO_CUSTODY,

      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "vault.workflow.create_private",
    title: "Create an API credential from private input",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame-id create api-credential",
      pwa: "route:/vault",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_open_password_workflow",
    },
    excluded: {
      mcp_host: NEVER_AGENT_SECRET,
      mcp_client: NEVER_AGENT_SECRET,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "vault.workflow.compare_private",
    title: "Compare a privately supplied credential value",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame-id password",
      pwa: "lib/vault/password-workflows.ts:comparePrivatePassword",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_open_password_workflow",
    },
    excluded: {
      mcp_host: NEVER_AGENT_SECRET,
      mcp_client: NEVER_AGENT_SECRET,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
  {
    id: "vault.workflow.update_private",
    title: "Update and verify a privately supplied credential value",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame-id password",
      pwa: "lib/vault/password-workflows.ts:comparePrivatePassword",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_open_password_workflow",
    },
    excluded: {
      mcp_host: NEVER_AGENT_SECRET,
      mcp_client: NEVER_AGENT_SECRET,
      extension: HANDOFF,
      android: WALLET_ONLY,
    },
  },
];
