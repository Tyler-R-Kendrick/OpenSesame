import type { Capability } from "./index.js";
export const identityManagementCapabilities: readonly Capability[] = [
  {
    id: "identity.agent.register",
    title: "Register a provisional agent identity",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id agent init",
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      webmcp: {
        reason:
          "Navigation opens Identity; directory and lifecycle changes require a human decision",
        adr: "0065-agent-surface-parity.md",
      },
      mcp_host: {
        reason:
          "agent bootstrap is an operator ceremony; an agent must not mint sibling agents",
        adr: "0065-agent-surface-parity.md",
      },
      mcp_client: {
        reason:
          "agent bootstrap is an operator ceremony; an agent must not mint sibling agents",
        adr: "0065-agent-surface-parity.md",
      },
    },
  },
  {
    id: "identity.agent.manage",
    title: "List, rename and revoke owned agent registrations",
    plane: "identity",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      webmcp: {
        reason:
          "Navigation opens Identity; directory and lifecycle changes require a human decision",
        adr: "0065-agent-surface-parity.md",
      },
      mcp_host: {
        reason: "Agent lifecycle changes are human administration",
        adr: "0065-agent-surface-parity.md",
      },
      mcp_client: {
        reason: "Agent lifecycle changes are human administration",
        adr: "0065-agent-surface-parity.md",
      },
    },
  },
  {
    id: "identity.users.manage",
    title: "Provision and manage organization directory users",
    plane: "identity",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      webmcp: {
        reason:
          "Navigation opens Identity; directory and lifecycle changes require a human decision",
        adr: "0065-agent-surface-parity.md",
      },
      mcp_host: {
        reason: "Directory provisioning requires the organization owner",
        adr: "0065-agent-surface-parity.md",
      },
      mcp_client: {
        reason: "Directory provisioning requires the organization owner",
        adr: "0065-agent-surface-parity.md",
      },
    },
  },
];
