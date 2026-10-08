import {
  AUTHENTICATOR_HANDOFF,
  AUTH_CEREMONY,
  CLIENT_NO_HOST_IDENTITY,
} from "./exclusions.js";
import type { Capability } from "./index.js";
import { localOrganizationCapabilities } from "./local-organizations.js";
import { orgSignInCapabilities } from "./org-signin.js";

export const identityManagementAgentCapabilities: readonly Capability[] = [
  {
    id: "identity.agent.register",
    title: "Register a provisional agent identity",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      cli: CLIENT_NO_HOST_IDENTITY,
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
  {
    id: "identity.claim.accept",
    title: "Review and accept an ownership claim",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/claim",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: AUTH_CEREMONY,
      mcp_client: AUTH_CEREMONY,
      webmcp: AUTH_CEREMONY,
    },
  },
  {
    id: "identity.drop.open",
    title: "Open a drop someone sent",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/claim",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: AUTH_CEREMONY,
      mcp_client: AUTH_CEREMONY,
      webmcp: AUTH_CEREMONY,
    },
  },
  {
    id: "identity.authenticator.invoke",
    title: "Hand an authenticator request to the native app",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/invoke/:kind",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      cli: AUTHENTICATOR_HANDOFF,
      mcp_host: AUTHENTICATOR_HANDOFF,
      mcp_client: AUTHENTICATOR_HANDOFF,
      webmcp: AUTHENTICATOR_HANDOFF,
    },
  },
  ...localOrganizationCapabilities,
  ...orgSignInCapabilities,
];
