import type { Capability, CapabilityExclusion } from "./index.js";

export const APPROVAL_CEREMONY: CapabilityExclusion = {
  reason:
    "a transaction-bound authenticator ceremony is what distinguishes a human approval from an agent asking for one; no agent surface may run or stand in for it",
  adr: "0084-external-authorization-notifications.md",
};

const humanReview: CapabilityExclusion = {
  reason:
    "Access opens the human review ceremony; an agent cannot read another person's inbox or settle its decisions",
  adr: "0084-external-authorization-notifications.md",
};

export const accessPortalCapabilities: readonly Capability[] = [
  {
    id: "tasks.start",
    title: "Start a task-scoped authority run",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame task start",
      pwa: "lib/access-sessions.ts:createAccessSession",
      mcp_host: "task_start",
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      webmcp: {
        reason:
          "The browser opens a human-confirmed ceiling form; programmatic task creation uses the scoped MCP Host task_start capability",
        adr: "0065-agent-surface-parity.md",
      },
    },
  },
  {
    id: "identity.approval.requests",
    title: "Create and review addressed authorization requests",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/access-requests.ts:createAccessRequest",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: humanReview,
      mcp_client: humanReview,
      webmcp: humanReview,
    },
  },
];
