import type { Capability, CapabilityExclusion } from "./index.js";

const ADR_LIFECYCLE_HOOKS = "0074-expiry-lifecycle-hooks.md";

export const SCOPED_AGENT_ONLY: CapabilityExclusion = {
  reason:
    "No reviewed scoped agent capability authorizes this surface; use the human CLI or browser",
  adr: "0099-scoped-local-agent-authority.md",
};

const HOOK_SECRET_ISSUANCE: CapabilityExclusion = {
  reason:
    "registering a lifecycle hook mints and returns a whsec_ signing secret once; an agent surface must never be the thing that receives it",
  adr: ADR_LIFECYCLE_HOOKS,
};

export const lifecycleCapabilities: readonly Capability[] = [
  // ── Host plane: expiry lifecycle hooks (ADR 0074) ─────────────────────
  {
    id: "lifecycle.expiring.read",
    title: "Read tracked expiry deadlines and their ladders",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame lifecycle expiring",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
    },
  },
  {
    id: "lifecycle.hooks.read",
    title: "Read registered expiry hook subscriptions",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame lifecycle hooks",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
    },
  },
  {
    id: "lifecycle.hooks.register",
    title: "Register an expiry hook subscription",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame lifecycle hook add",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: HOOK_SECRET_ISSUANCE,
      webmcp: HOOK_SECRET_ISSUANCE,
    },
  },
  {
    id: "lifecycle.hooks.remove",
    title: "Remove an expiry hook subscription",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame lifecycle hook rm",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "silently deleting a subscription blinds whoever depended on it; removal stays a deliberate human action alongside registration",
        adr: ADR_LIFECYCLE_HOOKS,
      },
      webmcp: {
        reason:
          "silently deleting a subscription blinds whoever depended on it; removal stays a deliberate human action alongside registration",
        adr: ADR_LIFECYCLE_HOOKS,
      },
    },
  },
  {
    id: "lifecycle.deliveries.read",
    title: "Read the outbound lifecycle delivery ledger",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame lifecycle deliveries",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
    },
  },
  {
    id: "lifecycle.scan.trigger",
    title: "Run one expiry scan now",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame lifecycle scan",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
    },
  },
];
