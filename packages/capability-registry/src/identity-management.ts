import type { Capability } from "./index.js";
export const identityManagementCapabilities: readonly Capability[] = [
  {
    id: "identity.local.requests.manage",
    title: "Create and decide encrypted local access requests",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/access",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "Custodian request administration requires explicit human authority",
        adr: "0111-browser-local-access-requests.md",
      },
      mcp_client: {
        reason: "An agent cannot approve its own requests as a human",
        adr: "0111-browser-local-access-requests.md",
      },
      webmcp: {
        reason:
          "Navigation can open Requests; decisions require bound human passkey verification",
        adr: "0111-browser-local-access-requests.md",
      },
    },
  },
  {
    id: "identity.local.policy.manage",
    title: "Configure browser-local application scope and role policies",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/access",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "Local policy administration belongs to the human vault custodian",
        adr: "0108-browser-local-application-scope-policy.md",
      },
      mcp_client: {
        reason: "Agents cannot widen their own scope admission policy",
        adr: "0108-browser-local-application-scope-policy.md",
      },
      webmcp: {
        reason:
          "Navigation may open Policies; admission changes require a human decision",
        adr: "0108-browser-local-application-scope-policy.md",
      },
    },
  },
  {
    id: "identity.local.access.manage",
    title: "Inspect and revoke vault-local sessions and application grants",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/access",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "Cross-principal revocation belongs to the human vault custodian",
        adr: "0110-human-approved-local-agent-application-grants.md",
      },
      mcp_client: {
        reason: "Agents cannot administer sibling sessions or grants",
        adr: "0110-human-approved-local-agent-application-grants.md",
      },
      webmcp: {
        reason:
          "Navigation may open Access; custodian revocation requires a human decision",
        adr: "0110-human-approved-local-agent-application-grants.md",
      },
    },
  },
  {
    id: "identity.local.agent.keys.manage",
    title: "Enroll and revoke local agent keys and verify machine sessions",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "Agent key enrollment and revocation belong to the human vault custodian",
        adr: "0109-browser-local-agent-authentication.md",
      },
      mcp_client: {
        reason:
          "Agents cannot register sibling credentials through the custodian ceremony",
        adr: "0109-browser-local-agent-authentication.md",
      },
      webmcp: {
        reason:
          "Navigation may open Identity; agents cannot approve their own key enrollment",
        adr: "0109-browser-local-agent-authentication.md",
      },
    },
  },
  {
    id: "identity.local.application.authorize",
    title: "Approve or deny browser-local application sign-in",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/identity/authorize",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "Local application consent requires the human and a verified passkey",
        adr: "0107-browser-local-application-grants.md",
      },
      mcp_client: {
        reason:
          "Local application consent requires the human and a verified passkey",
        adr: "0107-browser-local-application-grants.md",
      },
      webmcp: {
        reason:
          "Agents may navigate; they cannot approve their own application access",
        adr: "0107-browser-local-application-grants.md",
      },
    },
  },
  {
    id: "identity.local.passkeys.manage",
    title: "Manage vault-local passkeys and passkey-backed sessions",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "Credential enrollment and revocation require the human vault custodian",
        adr: "0103-browser-local-identity-passkeys.md",
      },
      mcp_client: {
        reason:
          "Credential enrollment and revocation require the human vault custodian",
        adr: "0103-browser-local-identity-passkeys.md",
      },
      webmcp: {
        reason:
          "Navigation may open Identity; passkey ceremonies require human activation",
        adr: "0103-browser-local-identity-passkeys.md",
      },
    },
  },
  {
    id: "identity.local.directory.manage",
    title:
      "Manage vault-local identities, memberships and application registrations",
    plane: "client_local",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason: "Local directory administration is a human operation",
        adr: "0102-vault-local-identity-directory.md",
      },
      mcp_client: {
        reason: "Local directory administration is a human operation",
        adr: "0102-vault-local-identity-directory.md",
      },
      webmcp: {
        reason:
          "Navigation opens Identity; directory mutations require a human decision",
        adr: "0102-vault-local-identity-directory.md",
      },
    },
  },
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
