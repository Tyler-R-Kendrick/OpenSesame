import type { Capability, CapabilityExclusion } from "./index.js";

const ADR_SHARED_SESSIONS = "0079-shared-sessions-and-scoped-grants.md";

const SESSION_AUTHORITY_CEREMONY: CapabilityExclusion = {
  reason:
    "hands one person reach into another's vault; deciding who may read somebody else's rows is a human decision, and an agent that could make it could admit itself",
  adr: ADR_SHARED_SESSIONS,
};

const SESSION_SURFACE_DEFERRED: CapabilityExclusion = {
  reason:
    "shared-session management is not yet exposed to agents; the transport and its ceremonies land first, then the surface is decided deliberately rather than by accretion",
  adr: ADR_SHARED_SESSIONS,
};

/**
 * Shared sessions and the coordination that surrounds them (ADR 0079).
 *
 * Presence and reach are separate here as they are everywhere else: seating
 * somebody is a different capability from granting them anything, which is
 * why an observer seat is not an agent-reachable way to be handed a key.
 */
export const sharedSessionCapabilities: readonly Capability[] = [
  {
    id: "shared_sessions.open",
    title: "Open a shared session",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_SURFACE_DEFERRED,
      mcp_client: SESSION_SURFACE_DEFERRED,
    },
  },
  {
    id: "shared_sessions.discover",
    title: "List public shared sessions",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_SURFACE_DEFERRED,
      mcp_client: SESSION_SURFACE_DEFERRED,
    },
  },
  {
    id: "shared_sessions.roster",
    title: "Read a shared session and its roster",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_SURFACE_DEFERRED,
      mcp_client: SESSION_SURFACE_DEFERRED,
    },
  },
  {
    id: "shared_sessions.activity",
    title: "Announce activity on an item in a shared session",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_SURFACE_DEFERRED,
      mcp_client: SESSION_SURFACE_DEFERRED,
    },
  },
  {
    id: "shared_sessions.events",
    title: "Subscribe to a shared session's live channel",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_SURFACE_DEFERRED,
      mcp_client: SESSION_SURFACE_DEFERRED,
    },
  },
  {
    id: "shared_sessions.grant",
    title: "Grant a participant scoped reach into a vault",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_AUTHORITY_CEREMONY,
      mcp_client: SESSION_AUTHORITY_CEREMONY,
      webmcp: SESSION_AUTHORITY_CEREMONY,
    },
  },
  {
    id: "shared_sessions.revoke",
    title: "Withdraw a participant's grant",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_SURFACE_DEFERRED,
      mcp_client: SESSION_SURFACE_DEFERRED,
    },
  },
  {
    id: "shared_sessions.join_request",
    title: "Ask to join a public shared session",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_SURFACE_DEFERRED,
      mcp_client: SESSION_SURFACE_DEFERRED,
      webmcp: SESSION_SURFACE_DEFERRED,
    },
  },
  {
    id: "shared_sessions.decide_join_request",
    title: "Admit or refuse a join request",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_AUTHORITY_CEREMONY,
      mcp_client: SESSION_AUTHORITY_CEREMONY,
      webmcp: SESSION_AUTHORITY_CEREMONY,
    },
  },
  {
    id: "shared_sessions.members",
    title: "Read who is in a shared session and in what standing",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_SURFACE_DEFERRED,
      mcp_client: SESSION_SURFACE_DEFERRED,
    },
  },
  {
    id: "shared_sessions.seat",
    title: "Seat somebody as an observer or participant, or end their seat",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_AUTHORITY_CEREMONY,
      mcp_client: SESSION_AUTHORITY_CEREMONY,
      webmcp: SESSION_AUTHORITY_CEREMONY,
    },
  },
  {
    id: "shared_sessions.close",
    title: "Close a shared session and end the reach it minted",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SESSION_AUTHORITY_CEREMONY,
      mcp_client: SESSION_AUTHORITY_CEREMONY,
      webmcp: SESSION_AUTHORITY_CEREMONY,
    },
  },
];
