/**
 * Agent-surface capability registry (ADR 0065).
 *
 * One literal list maps every product capability to the surfaces that carry
 * it: the CLIs, the PWA, both MCP servers, and WebMCP. Parity sweeps in each
 * surface package compare their implemented catalog against the views derived
 * here, so a capability cannot ship on one surface without either shipping on
 * the agent surfaces or carrying an explicit, ADR-cited exclusion.
 *
 * Surface string conventions:
 * - cli:    the command line as typed ("opensesame task terminate",
 *           "opensesame-id claim poll"); apps/cli and packages/cli parity
 *           tests assert the tokens exist in the clap/arg-parser sources.
 * - pwa:    "lib/<file>.ts:<export>" for an apps/pages seam the pages sweep
 *           import-checks, "route:/section" for a pages route, or
 *           "pwa-app:<surface>" for the thin apps/pwa shell.
 * - mcp_host / mcp_client: the MCP tool name on that server.
 * - webmcp: the navigator.modelContext tool name (pages unless the pwa
 *           surface is "pwa-app:*").
 */

export type Surface = "cli" | "pwa" | "mcp_host" | "mcp_client" | "webmcp";
export type AgentSurface = "mcp_host" | "mcp_client" | "webmcp";

export interface CapabilityExclusion {
  /** Why this capability is deliberately withheld from the surface. */
  readonly reason: string;
  /** ADR file name under docs/adr/ that records the decision. */
  readonly adr: string;
}

export interface Capability {
  readonly id: string;
  readonly title: string;
  readonly plane: "host" | "identity" | "client_local";
  readonly kind: "read" | "act" | "admin" | "ceremony";
  readonly surfaces: {
    readonly cli: string | null;
    readonly pwa: string | null;
    readonly mcp_host: string | null;
    readonly mcp_client: string | null;
    readonly webmcp: string | null;
  };
  /**
   * null on a surface means "not applicable"; an entry here means
   * "deliberately withheld" and must cite a real ADR. The registry self-test
   * requires every host/identity capability to be mapped or excluded on MCP,
   * and every capability with a pwa surface to be mapped or excluded on
   * WebMCP.
   */
  readonly excluded?: Partial<Record<AgentSurface, CapabilityExclusion>>;
}

const ADR_AUTHORITY_HANDLE = "0005-authority-handle-connectionref.md";
const ADR_MCP_BEARER = "0023-mcp-bearer-vs-dpop.md";
const ADR_PM_BRIDGING = "0052-password-manager-ecosystem-bridging.md";
const ADR_AGENT_SURFACE_PARITY = "0065-agent-surface-parity.md";
const ADR_LIFECYCLE_HOOKS = "0074-expiry-lifecycle-hooks.md";
const ADR_KEY_CUSTODY = "0075-host-certificate-key-custody.md";
const ADR_FIRST_RUN_SETUP = "0077-first-run-setup-ceremony.md";
const ADR_SHARED_SESSIONS = "0079-shared-sessions-and-scoped-grants.md";
const ADR_SECURITY_EVENTS = "0080-security-event-hooks.md";
const ADR_LIVE_OBSERVATION = "0081-live-session-observation.md";
const ADR_MODEL_PLANE = "0083-browser-plane-inference-fallback.md";
const ADR_NOTIFICATION_CEREMONIES =
  "0084-external-authorization-notifications.md";
const ADR_PWA_INSTALL = "0085-pwa-install-offer.md";
const ADR_INTERACTION_LAYER = "0086-wallet-native-interaction-layer.md";

const NEVER_AGENT_SECRET: CapabilityExclusion = {
  reason:
    "raw secret material must never transit agent context; agents hold ConnectionRefs only",
  adr: ADR_AUTHORITY_HANDLE,
};

const AUTH_CEREMONY: CapabilityExclusion = {
  reason:
    "authentication ceremonies run out-of-band; inbound agent tokens are never minted or forwarded by tools",
  adr: ADR_MCP_BEARER,
};

const INTERACTION_APPROVAL: CapabilityExclusion = {
  reason:
    "approving an interaction is the human decision the whole layer exists to obtain; an agent surface that could answer one would make the ceremony decorative",
  adr: ADR_INTERACTION_LAYER,
};

const INTERACTION_REQUESTER_CHANNEL: CapabilityExclusion = {
  reason:
    "the requester already learns the outcome on the channel it created the interaction on; a second agent-facing read would be a way to watch somebody else's inbox",
  adr: ADR_INTERACTION_LAYER,
};

const HUMAN_CEREMONY: CapabilityExclusion = {
  reason:
    "consequential authority grant/approval; headless agents get read-only visibility, WebMCP opens the ceremony for a human decision",
  adr: ADR_AGENT_SURFACE_PARITY,
};

const OPS_PLANE: CapabilityExclusion = {
  reason: "operator/device lifecycle surface, not an agent capability",
  adr: ADR_AGENT_SURFACE_PARITY,
};

/**
 * Where an authorization prompt appears is who gets to approve it. An agent
 * that could rebind a destination could route its principal's prompts to
 * itself, so this is withheld from every agent surface rather than merely
 * gated.
 */
const APPROVAL_ROUTING: CapabilityExclusion = {
  reason:
    "binding a notification destination decides where authorization prompts appear; an agent that could rebind one could route its principal's prompts to itself",
  adr: ADR_NOTIFICATION_CEREMONIES,
};

const APPROVAL_CEREMONY: CapabilityExclusion = {
  reason:
    "a transaction-bound authenticator ceremony is what distinguishes a human approval from an agent asking for one; no agent surface may run or stand in for it",
  adr: ADR_NOTIFICATION_CEREMONIES,
};

const PM_PLANE: CapabilityExclusion = {
  reason:
    "password-manager ecosystem surface is human/device/ops plane only, never agent-facing",
  adr: ADR_PM_BRIDGING,
};

const HOOK_SECRET_ISSUANCE: CapabilityExclusion = {
  reason:
    "registering a lifecycle hook mints and returns a whsec_ signing secret once; an agent surface must never be the thing that receives it",
  adr: ADR_LIFECYCLE_HOOKS,
};

const BREACH_CHECK_TAKES_A_SECRET: CapabilityExclusion = {
  reason:
    "the only route that accepts a secret value; an agent surface must never be the thing that carries one, even to have it vetted",
  adr: ADR_SECURITY_EVENTS,
};

const CUSTODY_KEY_MATERIAL: CapabilityExclusion = {
  reason:
    "returns or places a certificate private key; agent-facing APIs carry references, never material",
  adr: ADR_KEY_CUSTODY,
};

const DEFERRED: CapabilityExclusion = {
  reason:
    "not yet exposed to agents; revisit deliberately rather than by accretion",
  adr: ADR_AGENT_SURFACE_PARITY,
};

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

const MODEL_PLANE_REDIRECT: CapabilityExclusion = {
  reason:
    "choosing the model plane names the endpoint redacted frames are sent to; an agent able to make that choice holds a redirect primitive, and the boundary holds only because nobody untrusted picks the destination",
  adr: ADR_MODEL_PLANE,
};

const DEVICE_GESTURE: CapabilityExclusion = {
  reason:
    "installing is a browser-mediated act on the human's own device: the install dialog only opens inside a transient user activation, and there is no gesture an agent can supply or consent it can give on the device owner's behalf",
  adr: ADR_PWA_INSTALL,
};

const FIRST_RUN_CEREMONY: CapabilityExclusion = {
  reason:
    "the anonymous first visitor is the deployment's operator; letting an agent answer who this app trusts for identity would let it choose the issuer that authenticates every later human",
  adr: ADR_FIRST_RUN_SETUP,
};

export const CAPABILITIES: readonly Capability[] = [
  // ── Host plane: health, discovery, session ────────────────────────────
  {
    id: "host.health",
    title: "Host API and daemon health/readiness",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame status",
      pwa: "pwa-app:health",
      mcp_host: "host_ready",
      mcp_client: "host_health",
      webmcp: "opensesame_pwa_health",
    },
  },
  {
    id: "host.health.pages",
    title: "Connectivity posture inside the authority vault",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: "host_ready",
      mcp_client: "host_health",
      webmcp: "opensesame_health",
    },
  },
  {
    id: "host.discovery",
    title: "Protected-resource metadata discovery",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame doctor",
      pwa: null,
      mcp_host: null,
      mcp_client: "host_discover",
      webmcp: null,
    },
  },
  {
    id: "host.whoami",
    title: "Resolve the authenticated principal",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame whoami",
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: "whoami",
      webmcp: "opensesame_status",
    },
  },
  {
    id: "host.login",
    title: "Host device/loopback login",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame login",
      pwa: null,
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
    id: "daemon.status",
    title: "Local host agent status",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame daemon status",
      pwa: "pwa-app:daemon-probe",
      mcp_host: "daemon_status",
      mcp_client: null,
      webmcp: "opensesame_pwa_health",
    },
  },
  {
    id: "daemon.lifecycle",
    title: "Install/start/stop the local host agent",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame daemon install",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: OPS_PLANE, mcp_client: OPS_PLANE },
  },

  // ── Host plane: intents, tasks, receipts ──────────────────────────────
  {
    id: "intents.invoke",
    title: "Capability invoke through a ConnectionRef",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame invoke",
      pwa: null,
      mcp_host: null,
      mcp_client: "invoke_l1",
      webmcp: null,
    },
  },
  {
    id: "tasks.start",
    title: "Start a task-scoped authority run",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame task start",
      pwa: null,
      mcp_host: "task_start",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "tasks.list",
    title: "List task runs",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame task list",
      pwa: "lib/access.ts:listTasks",
      mcp_host: "task_list",
      mcp_client: null,
      webmcp: "opensesame_access_read",
    },
  },
  {
    id: "tasks.inspect",
    title: "Inspect a task run and its capability ceiling",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame task inspect",
      pwa: "lib/access.ts:getTask",
      mcp_host: "task_status",
      mcp_client: null,
      webmcp: "opensesame_access_read",
    },
  },
  {
    id: "tasks.terminate",
    title: "Terminate a task run",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame task terminate",
      pwa: "lib/access.ts:terminateTask",
      mcp_host: "task_terminate",
      mcp_client: null,
      webmcp: "opensesame_task_terminate",
    },
  },
  {
    id: "tasks.intent.freeze",
    title: "Freeze a task-bound intent",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame intent create",
      pwa: null,
      mcp_host: "task_invoke",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "tasks.intent.spend",
    title: "Spend a frozen intent through the operator broker",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame intent invoke",
      pwa: null,
      mcp_host: "operator_invoke_l1",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "receipts.read",
    title: "Read invocation receipts",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/access",
      mcp_host: "receipt_read",
      mcp_client: null,
      webmcp: "opensesame_access_read",
    },
  },
  {
    id: "receipts.verify",
    title: "Verify a receipt signature",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame receipt verify",
      pwa: null,
      mcp_host: "receipt_verify",
      mcp_client: null,
      webmcp: null,
    },
  },

  // ── Host plane: shared sessions (ADR 0079) ────────────────────────────
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

  // ── Host plane: delegations, offers, relay ────────────────────────────
  {
    id: "delegations.list",
    title: "List delegations",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "lib/access.ts:listDelegations",
      mcp_host: "delegation_read",
      mcp_client: null,
      webmcp: "opensesame_access_read",
    },
  },
  {
    id: "delegations.offers.list",
    title: "List delegation offers",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "lib/access.ts:listMyOffers",
      mcp_host: "delegation_offer_read",
      mcp_client: null,
      webmcp: "opensesame_access_read",
    },
  },
  {
    id: "delegations.narrow",
    title: "Narrow a delegation (restriction only)",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "lib/access.ts:narrowDelegation",
      mcp_host: "delegation_narrow",
      mcp_client: null,
      webmcp: "opensesame_delegation_narrow",
    },
  },
  {
    id: "delegations.revoke",
    title: "Revoke a delegation",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "lib/access.ts:revokeDelegation",
      mcp_host: "delegation_revoke",
      mcp_client: null,
      webmcp: "opensesame_delegation_revoke",
    },
  },
  {
    id: "delegations.offers.revoke",
    title: "Revoke a delegation offer",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "lib/access.ts:revokeOffer",
      mcp_host: "delegation_revoke",
      mcp_client: null,
      webmcp: "opensesame_delegation_revoke",
    },
  },
  {
    id: "delegations.offers.mint",
    title: "Mint a delegation offer (grant ceremony)",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/access.ts:mintOffer",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: HUMAN_CEREMONY,
      mcp_client: HUMAN_CEREMONY,
      webmcp: HUMAN_CEREMONY,
    },
  },
  {
    id: "delegations.claim",
    title: "Claim a delegation offer",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/access.ts:claimDelegation",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_open_delegation_claim",
    },
    excluded: { mcp_host: HUMAN_CEREMONY, mcp_client: HUMAN_CEREMONY },
  },
  {
    id: "relay.inbox",
    title: "Read pending relay approval requests",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "lib/access.ts:listRelayRequests",
      mcp_host: "relay_request_read",
      mcp_client: null,
      webmcp: "opensesame_access_read",
    },
  },
  {
    id: "relay.decide",
    title: "Approve or deny a relay request",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/access.ts:approveRelayRequest",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_open_relay_approval",
    },
    excluded: { mcp_host: HUMAN_CEREMONY, mcp_client: HUMAN_CEREMONY },
  },
  {
    id: "agent_identities.read",
    title: "Read registered agent identities",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/access",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_access_read",
    },
    // The gateway only exposes POST /api/v1/agent-identities (claim start);
    // there is no list/read route yet, so an MCP tool here could never
    // succeed. Map it once the gateway grows the read endpoint.
    excluded: { mcp_host: DEFERRED, mcp_client: DEFERRED },
  },

  // ── Host plane: providers, connections, integrations ──────────────────
  {
    id: "providers.list",
    title: "Browse the provider catalog",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame provider list",
      pwa: "lib/connections.ts:listProviders",
      mcp_host: "provider_read",
      mcp_client: null,
      webmcp: "opensesame_connections_read",
    },
  },
  {
    id: "providers.test",
    title: "Probe provider readiness",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame provider test",
      pwa: null,
      mcp_host: "provider_test",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "connections.list",
    title: "List connections",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame connect ls",
      pwa: "lib/connections.ts:listConnections",
      mcp_host: "connection_read",
      mcp_client: "list_connections",
      webmcp: "opensesame_connections_read",
    },
  },
  {
    id: "connections.inspect",
    title: "Inspect a connection and its activity",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame connect inspect",
      pwa: "lib/connections.ts:getConnection",
      mcp_host: "connection_read",
      mcp_client: null,
      webmcp: "opensesame_connections_read",
    },
  },
  {
    id: "connections.create",
    title: "Create a connection (consent + credential ceremony)",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame connect create",
      pwa: "lib/connections.ts:createConnection",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_open_connect_ceremony",
    },
    excluded: {
      mcp_host: NEVER_AGENT_SECRET,
      mcp_client: NEVER_AGENT_SECRET,
    },
  },
  {
    id: "connections.credential.set",
    title: "Enter or replace a connection credential",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/connections.ts:setConnectionCredential",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: NEVER_AGENT_SECRET,
      mcp_client: NEVER_AGENT_SECRET,
      webmcp: NEVER_AGENT_SECRET,
    },
  },
  {
    id: "connections.update",
    title: "Update connection coordinates or delegation ceiling",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame connect update",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "coordinate updates can re-aim where a credential is presented; humans own re-aiming",
        adr: ADR_AGENT_SURFACE_PARITY,
      },
      mcp_client: {
        reason:
          "coordinate updates can re-aim where a credential is presented; humans own re-aiming",
        adr: ADR_AGENT_SURFACE_PARITY,
      },
    },
  },
  {
    id: "connections.bindings",
    title: "Attach/detach a connection binding (authority grant)",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame connect attach",
      pwa: "lib/connections.ts:bindConnection",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_open_connect_ceremony",
    },
    excluded: { mcp_host: HUMAN_CEREMONY, mcp_client: HUMAN_CEREMONY },
  },
  {
    id: "connections.rotate",
    title: "Enqueue a connection credential rotation",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame connect rotate",
      pwa: null,
      mcp_host: "connection_rotate",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "connections.remove",
    title: "Revoke a connection",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame connect rm",
      pwa: "lib/connections.ts:revokeConnection",
      mcp_host: "connection_remove",
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      webmcp: {
        reason:
          "destructive revocation confirmed by the human in the connections UI",
        adr: ADR_AGENT_SURFACE_PARITY,
      },
    },
  },
  {
    id: "connections.discover",
    title: "Import host-detected connectors",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame connect discover",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: HUMAN_CEREMONY, mcp_client: HUMAN_CEREMONY },
  },
  {
    id: "connections.portability",
    title: "Export/import non-secret connection configuration",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame export",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: OPS_PLANE, mcp_client: OPS_PLANE },
  },
  {
    id: "integrations.read",
    title: "Read configured integrations",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "lib/connections.ts:listIntegrations",
      mcp_host: null,
      mcp_client: "integration_read",
      webmcp: "opensesame_connections_read",
    },
  },

  // ── Host plane: certs, configs, sync, rotation, backup ────────────────
  {
    id: "certs.list",
    title: "List issued certificates",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame cert ls",
      pwa: null,
      mcp_host: "cert_read",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "certs.issue",
    title: "Issue a certificate",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame cert issue",
      pwa: "lib/certs.ts:issueCertificate",
      mcp_host: "cert_issue",
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      webmcp: {
        reason:
          "issuance delivers private key material to the device; the human runs it from the vault UI",
        adr: ADR_AGENT_SURFACE_PARITY,
      },
    },
  },
  {
    id: "certs.ca",
    title: "Fetch/establish the certificate authority",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame cert ca",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: OPS_PLANE, mcp_client: OPS_PLANE },
  },
  {
    id: "configs.browse",
    title: "Browse secret-config keys and metadata (never values)",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame config keys",
      pwa: "route:/settings",
      mcp_host: "config_read",
      mcp_client: "config_metadata_read",
      webmcp: "opensesame_settings_read",
    },
  },
  {
    id: "configs.audit",
    title: "Secret-config history and environment diff (metadata only)",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame config history",
      pwa: null,
      mcp_host: "config_read",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "configs.set",
    title: "Write a secret-config value (write-only intake)",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame config set",
      pwa: "route:/settings",
      mcp_host: "config_set",
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      webmcp: {
        reason: "secret value entry stays in the human settings UI",
        adr: ADR_AGENT_SURFACE_PARITY,
      },
    },
  },
  {
    id: "configs.rollback",
    title: "Roll a secret-config key back to a prior version",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame config rollback",
      pwa: null,
      mcp_host: "config_rollback",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "configs.values.read",
    title: "Read secret-config values",
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
      mcp_host: NEVER_AGENT_SECRET,
      mcp_client: NEVER_AGENT_SECRET,
      webmcp: NEVER_AGENT_SECRET,
    },
  },
  {
    id: "sync.push",
    title: "Push encrypted sync blobs",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame sync push",
      pwa: null,
      mcp_host: "sync_push",
      mcp_client: "sync_push",
      webmcp: null,
    },
  },
  {
    id: "sync.pull",
    title: "Pull encrypted sync blobs",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame sync pull",
      pwa: null,
      mcp_host: "sync_pull",
      mcp_client: "sync_pull",
      webmcp: null,
    },
  },
  {
    id: "sync_targets.read",
    title: "Read replication sync targets",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: "sync_target_read",
      mcp_client: "sync_target_read",
      webmcp: "opensesame_settings_read",
    },
  },
  {
    id: "sync_targets.trigger",
    title: "Trigger a sync-target replication run",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: DEFERRED,
      mcp_client: DEFERRED,
      webmcp: DEFERRED,
    },
  },
  {
    id: "rotations.read",
    title: "Read rotation queue and policies",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: "rotation_read",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "rotations.trigger",
    title: "Enqueue a rotation run",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame connection rotate",
      pwa: null,
      mcp_host: "rotation_trigger",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "certificates.custody.issue",
    title: "Issue a certificate under host key custody",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame cert issue",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: CUSTODY_KEY_MATERIAL,
      webmcp: CUSTODY_KEY_MATERIAL,
    },
  },
  {
    id: "certificates.custody.reveal",
    title: "Collect a host-custody private key",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame cert key",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: CUSTODY_KEY_MATERIAL,
      webmcp: CUSTODY_KEY_MATERIAL,
    },
  },
  // ── Host plane: expiry lifecycle hooks (ADR 0074) ─────────────────────
  {
    id: "lifecycle.expiring.read",
    title: "Read tracked expiry deadlines and their ladders",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame lifecycle expiring",
      pwa: null,
      mcp_host: "lifecycle_expiring_read",
      mcp_client: null,
      webmcp: null,
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
      mcp_host: "lifecycle_hooks_read",
      mcp_client: null,
      webmcp: null,
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
      mcp_host: "lifecycle_deliveries_read",
      mcp_client: null,
      webmcp: null,
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
      mcp_host: "lifecycle_scan",
      mcp_client: null,
      webmcp: null,
    },
  },
  // ── Host plane: breach exposure (ADR 0080) ────────────────────────────
  {
    id: "security.findings.read",
    title: "Read breach findings for this organization",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame security findings",
      pwa: null,
      mcp_host: "security_findings_read",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "security.breach_scan.trigger",
    title: "Run one breach scan now",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame security scan",
      pwa: null,
      mcp_host: "security_breach_scan",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "security.breach_check.run",
    title: "Check a candidate secret against the breached-password corpus",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame security check",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: BREACH_CHECK_TAKES_A_SECRET,
      webmcp: BREACH_CHECK_TAKES_A_SECRET,
    },
  },
  {
    id: "agent.runs.read",
    title: "Read sandboxed agent runs and their control state",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame rotate runs",
      pwa: null,
      mcp_host: "agent_runs_read",
      mcp_client: null,
      webmcp: null,
    },
  },
  {
    id: "agent.runs.observe",
    title: "Read a run's sealed observation log",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame rotate watch",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "the observation log is an authenticated view of somebody's account, sealed to their viewer key; extending ADR 0076 §5's recording exclusion to the live tail of the same log",
        adr: ADR_LIVE_OBSERVATION,
      },
      webmcp: {
        reason:
          "the observation log is an authenticated view of somebody's account, sealed to their viewer key; extending ADR 0076 §5's recording exclusion to the live tail of the same log",
        adr: ADR_LIVE_OBSERVATION,
      },
    },
  },
  {
    id: "agent.runs.control",
    title: "Ask a run's agent to park, then take the page",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame rotate attach",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "driving a live authenticated session at a third party is a human ceremony; the lease is granted to a person holding the viewer key, never to a tool call",
        adr: ADR_LIVE_OBSERVATION,
      },
      webmcp: {
        reason:
          "driving a live authenticated session at a third party is a human ceremony; the lease is granted to a person holding the viewer key, never to a tool call",
        adr: ADR_LIVE_OBSERVATION,
      },
    },
  },
  {
    id: "model_plane.read",
    title: "Read which plane runs the password-reset model",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_settings_read",
    },
  },
  {
    id: "model_plane.choose",
    title: "Choose who runs the password-reset model",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: MODEL_PLANE_REDIRECT,
      mcp_client: MODEL_PLANE_REDIRECT,
      webmcp: MODEL_PLANE_REDIRECT,
    },
  },
  {
    id: "changelog.read",
    title: "Read the project changelog feed",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: "changelog_read",
      mcp_client: null,
      webmcp: "opensesame_settings_read",
    },
  },
  {
    id: "backup.status",
    title: "Read server-side backup posture",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: "backup_status",
      mcp_client: null,
      webmcp: "opensesame_settings_read",
    },
  },
  {
    id: "backup.target.set",
    title: "Configure the server-side backup target",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: OPS_PLANE,
      mcp_client: OPS_PLANE,
      webmcp: OPS_PLANE,
    },
  },

  // ── Host plane: human-only secret surfaces (explicit exclusions) ──────
  {
    id: "secrets.materialize",
    title: "Reveal secrets, acquire leases, run crypto plans",
    plane: "host",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame secret get",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: NEVER_AGENT_SECRET,
      mcp_client: NEVER_AGENT_SECRET,
      webmcp: NEVER_AGENT_SECRET,
    },
  },
  {
    id: "sealed_store.pass",
    title: "Sealed password-store verbs (pass parity)",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame pass show",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: PM_PLANE,
      mcp_client: PM_PLANE,
      webmcp: PM_PLANE,
    },
  },
  {
    id: "sealed_store.attach.replicate",
    title: "Replicate sealed attachments to the Host target",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame pass attach sync",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: PM_PLANE, mcp_client: PM_PLANE },
  },

  // ── Identity plane ─────────────────────────────────────────────────────
  {
    id: "identity.claims.poll",
    title: "Poll a claim session",
    plane: "identity",
    kind: "read",
    surfaces: {
      cli: "opensesame-id claim poll",
      pwa: null,
      mcp_host: null,
      mcp_client: "present_claim",
      webmcp: null,
    },
  },
  // ── Identity plane: cross-device interactions (ADR 0086) ───────────────
  //
  // None of these map onto an agent surface, and that is the design rather
  // than a backlog. The layer exists to put a question in front of a person
  // and take an answer bound to a cryptographic proof; a tool that could
  // answer one would remove the only step that makes the answer mean
  // anything. They are listed here so the parity sweep sees a decision
  // instead of an omission.
  {
    id: "identity.interaction.create",
    title: "Ask someone to authorize an operation",
    plane: "identity",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: INTERACTION_REQUESTER_CHANNEL,
      mcp_client: INTERACTION_REQUESTER_CHANNEL,
      webmcp: INTERACTION_REQUESTER_CHANNEL,
    },
  },
  {
    id: "identity.interaction.approve",
    title: "Approve a cross-device interaction",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: INTERACTION_APPROVAL,
      mcp_client: INTERACTION_APPROVAL,
      webmcp: INTERACTION_APPROVAL,
    },
  },
  {
    id: "identity.interaction.deny",
    title: "Deny a cross-device interaction",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: INTERACTION_APPROVAL,
      mcp_client: INTERACTION_APPROVAL,
      webmcp: INTERACTION_APPROVAL,
    },
  },
  {
    id: "identity.login",
    title: "Identity sign-in (device, loopback, anonymous)",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id login",
      pwa: "pwa-app:sign-in",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_open_sign_in",
    },
    excluded: { mcp_host: AUTH_CEREMONY, mcp_client: AUTH_CEREMONY },
  },
  {
    id: "identity.whoami",
    title: "Resolve the identity-plane principal",
    plane: "identity",
    kind: "read",
    surfaces: {
      cli: "opensesame-id whoami",
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_identity_read",
    },
    excluded: { mcp_host: DEFERRED, mcp_client: DEFERRED },
  },
  {
    id: "identity.agent.register",
    title: "Register a provisional agent identity",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id agent init",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "agent bootstrap is an operator ceremony; an agent must not mint sibling agents",
        adr: ADR_AGENT_SURFACE_PARITY,
      },
      mcp_client: {
        reason:
          "agent bootstrap is an operator ceremony; an agent must not mint sibling agents",
        adr: ADR_AGENT_SURFACE_PARITY,
      },
    },
  },
  {
    id: "identity.project.temporary",
    title: "Create a temporary project",
    plane: "identity",
    kind: "act",
    surfaces: {
      cli: "opensesame-id project create",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: DEFERRED, mcp_client: DEFERRED },
  },
  {
    id: "identity.admin",
    title: "People, providers, devices, orgs, OAuth clients, audit",
    plane: "identity",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: "route:/identity",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_identity_read",
    },
    excluded: {
      mcp_host: {
        reason:
          "identity administration is a human/ops surface; WebMCP exposes reads only",
        adr: ADR_AGENT_SURFACE_PARITY,
      },
      mcp_client: {
        reason:
          "identity administration is a human/ops surface; WebMCP exposes reads only",
        adr: ADR_AGENT_SURFACE_PARITY,
      },
    },
  },
  {
    id: "identity.device.approve",
    title: "Approve a device sign-in",
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
      mcp_host: AUTH_CEREMONY,
      mcp_client: AUTH_CEREMONY,
      webmcp: AUTH_CEREMONY,
    },
  },

  {
    id: "identity.notification.channels.read",
    title: "List notification channels and what each can do",
    plane: "identity",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: APPROVAL_ROUTING,
      mcp_client: APPROVAL_ROUTING,
    },
  },
  {
    id: "identity.notification.bindings.manage",
    title: "Bind, verify, or revoke a notification destination",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: APPROVAL_ROUTING,
      mcp_client: APPROVAL_ROUTING,
    },
  },
  {
    id: "identity.notification.preferences.manage",
    title: "Read or change where authorization prompts are delivered",
    plane: "identity",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: APPROVAL_ROUTING,
      mcp_client: APPROVAL_ROUTING,
    },
  },
  {
    id: "identity.approval.activation",
    title: "Run the transaction-bound authenticator ceremony for an approval",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: APPROVAL_CEREMONY,
      mcp_client: APPROVAL_CEREMONY,
    },
  },
  {
    id: "identity.approval.comparison",
    title: "Issue and check the number-matching value for an approval",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: APPROVAL_CEREMONY,
      mcp_client: APPROVAL_CEREMONY,
    },
  },
  {
    id: "identity.approval.report",
    title: "Report an authorization request as unrecognized",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: APPROVAL_CEREMONY,
      mcp_client: APPROVAL_CEREMONY,
    },
  },
  {
    id: "identity.approval.receipt.read",
    title: "Read the decision receipt for an authorization request",
    plane: "identity",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: {
        reason:
          "a receipt names the approver, the channel and the binding that settled a request; agent visibility into who approved what is deferred until a scoped projection exists",
        adr: ADR_NOTIFICATION_CEREMONIES,
      },
      mcp_client: {
        reason:
          "a receipt names the approver, the channel and the binding that settled a request; agent visibility into who approved what is deferred until a scoped projection exists",
        adr: ADR_NOTIFICATION_CEREMONIES,
      },
    },
  },

  // ── Client-local plane: the authority vault (apps/pages) ──────────────
  {
    id: "vault.items.search",
    title: "Search vault items (names, folders, kinds, flags)",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "lib/vault/store.ts:vaultStore",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_vault_search",
    },
  },
  {
    id: "vault.items.read_meta",
    title: "Read vault item metadata (never secret fields)",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "lib/vault/store.ts:vaultStore",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_vault_item_read",
    },
  },
  {
    id: "vault.items.write_meta",
    title: "Create/edit vault item non-secret metadata",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: "lib/vault/store.ts:vaultStore",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_vault_item_write",
    },
  },
  {
    id: "vault.items.reveal",
    title: "Reveal a vault item secret",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/vault",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_open_reveal",
    },
  },
  {
    id: "vault.totp.code",
    title: "Read a current TOTP code (never the seed)",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/vault",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_totp_code",
    },
  },
  {
    id: "vault.totp.seed",
    title: "Read a TOTP seed",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: NEVER_AGENT_SECRET,
      mcp_client: NEVER_AGENT_SECRET,
      webmcp: NEVER_AGENT_SECRET,
    },
  },
  {
    id: "vault.export",
    title: "Export/backup the vault (plaintext-capable)",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: NEVER_AGENT_SECRET },
  },

  // ── Client-local plane: app shell surfaces ─────────────────────────────
  {
    id: "app.status",
    title: "App/session status summary",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_status",
    },
  },
  {
    id: "app.navigate",
    title: "Navigate between app sections",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_navigate",
    },
  },
  {
    id: "pwa.status",
    title: "Thin PWA session status",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "pwa-app:status",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_pwa_status",
    },
  },
  {
    id: "app.install",
    title: "Install the PWA on this device",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/install.ts:installWorthShowing",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: DEVICE_GESTURE },
  },
  {
    id: "setup.first_run",
    title: "First-run deployment setup ceremony",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/setup.ts:setupRequired",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: FIRST_RUN_CEREMONY },
  },
] as const;

/**
 * Union of the per-app secret-name denylists
 * (apps/mcp-host assertsNoSecretTools + apps/mcp-client
 * assertsNoMaterializeTool), applied to every agent catalog including WebMCP.
 */
export const AGENT_SECRET_NAME_PATTERN =
  /secret|materialize|get_secret|pass_show|sealed_store_show|password_store_read|^show$/i;

export function assertsNoSecretNames(names: readonly string[]): void {
  if (names.some((n) => AGENT_SECRET_NAME_PATTERN.test(n))) {
    throw new Error("secret_tools_forbidden");
  }
}

function surfaceNames(surface: AgentSurface): readonly string[] {
  const names = new Set<string>();
  for (const capability of CAPABILITIES) {
    const name = capability.surfaces[surface];
    if (name) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** Every MCP host-server tool name the registry demands. */
export function mcpHostCatalog(): readonly string[] {
  return surfaceNames("mcp_host");
}

/** Every MCP client-server tool name the registry demands. */
export function mcpClientCatalog(): readonly string[] {
  return surfaceNames("mcp_client");
}

/** Every WebMCP tool name the registry demands, across both PWAs. */
export function webmcpCatalog(): readonly string[] {
  return surfaceNames("webmcp");
}

function isPwaAppSurface(capability: Capability): boolean {
  return capability.surfaces.pwa?.startsWith("pwa-app:") ?? false;
}

/** WebMCP tool names owned by apps/pages (the authority vault). */
export function webmcpPagesCatalog(): readonly string[] {
  const names = new Set<string>();
  for (const capability of CAPABILITIES) {
    const name = capability.surfaces.webmcp;
    if (name && !isPwaAppSurface(capability)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** WebMCP tool names owned by apps/pwa (the thin shell). */
export function webmcpPwaCatalog(): readonly string[] {
  const names = new Set<string>();
  for (const capability of CAPABILITIES) {
    const name = capability.surfaces.webmcp;
    if (name && isPwaAppSurface(capability)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** Capabilities deliberately withheld from a surface, for docs and audits. */
export function exclusionsFor(
  surface: AgentSurface,
): readonly { id: string; reason: string; adr: string }[] {
  return CAPABILITIES.filter((c) => c.excluded?.[surface]).map((c) => {
    const exclusion = c.excluded?.[surface];
    if (!exclusion) {
      throw new Error(`exclusion_missing:${c.id}`);
    }
    return { id: c.id, reason: exclusion.reason, adr: exclusion.adr };
  });
}
