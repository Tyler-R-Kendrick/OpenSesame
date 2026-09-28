import type { Capability } from "./index.js";

/**
 * The signed-in member's organizations (ADR 0105): session-enforced reads
 * and edits a local person's own passkey session performs in the tab that
 * signed in. Never the vault custodian's root authority, and never an agent
 * surface — a session's presentation authority does not leave the page
 * (ADR 0104), and agents are never owners or admins.
 */
export const localOrganizationCapabilities: readonly Capability[] = [
  {
    id: "identity.local.organizations.read",
    title:
      "Read the organizations a signed-in local person or agent belongs to, and their members",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "lib/local-organizations.ts:listLocalOrganizations",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "Organization reads are session-enforced; a local session's presentation authority never leaves the tab that signed in",
        adr: "0105-browser-local-organization-membership.md",
      },
      mcp_client: {
        reason:
          "Organization reads are session-enforced; a local session's presentation authority never leaves the tab that signed in",
        adr: "0105-browser-local-organization-membership.md",
      },
      webmcp: {
        reason:
          "Navigation may open Identity; a model tool result may not carry a local session handle or its members",
        adr: "0104-browser-local-identity-sessions.md",
      },
    },
  },
  {
    id: "identity.local.organizations.membership.manage",
    title:
      "Change or remove organization members from a signed-in local passkey session",
    plane: "client_local",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: "lib/local-organizations.ts:changeLocalOrganizationMembership",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "Membership edits need a person's passkey session in the tab; the fenced commit primitive is not an RPC or agent surface",
        adr: "0105-browser-local-organization-membership.md",
      },
      mcp_client: {
        reason: "Agents are never owners or admins and cannot edit memberships",
        adr: "0105-browser-local-organization-membership.md",
      },
      webmcp: {
        reason:
          "Navigation may open Identity; a membership change is the signed-in person's decision",
        adr: "0105-browser-local-organization-membership.md",
      },
    },
  },
];
