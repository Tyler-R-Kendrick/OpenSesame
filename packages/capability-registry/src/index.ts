import {
  APPROVAL_CEREMONY,
  accessPortalCapabilities,
} from "./access-portal.js";
import { connectorDirectoryCapabilities } from "./connectors.js";
import { enrollmentCapabilities } from "./enrollment.js";
import {
  ADR_AGENT_SURFACE_PARITY,
  ADR_CEREMONIES,
  ADR_LIVE_OBSERVATION,
  ADR_NOTIFICATION_CEREMONIES,
  APPROVAL_ROUTING,
  AUTH_CEREMONY,
  BREACH_CHECK_TAKES_A_SECRET,
  COMMAND_BAR_HUMAN_ONLY,
  CUSTODY_KEY_MATERIAL,
  DEFERRED,
  DEVICE_GESTURE,
  DEVICE_VAULT_CEREMONY,
  FIRST_RUN_CEREMONY,
  HUMAN_CEREMONY,
  INTERACTION_APPROVAL,
  INTERACTION_REQUESTER_CHANNEL,
  IN_PAGE_GUIDANCE_ONLY,
  MODEL_PLANE_REDIRECT,
  NEVER_AGENT_SECRET,
  OPS_PLANE,
  PAGES_HAS_NO_HOST,
  PM_PLANE,
} from "./exclusions.js";
import { generalAuthorityCapabilities } from "./general-authority.js";
import { identityManagementCapabilities } from "./identity-management.js";
import { itemTypeCapabilities } from "./item-types.js";
import { nativeHostCapabilities } from "./native-host.js";
import { sharedSessionCapabilities } from "./shared-sessions.js";
/**
 * Agent-surface capability registry (ADR 0065).
 * One literal list maps every product capability to the surfaces that carry
 * it: the CLIs, the PWA, both MCP servers, and WebMCP. Parity sweeps in each
 * surface package compare their implemented catalog against the views derived
 * here, so a capability cannot ship on one surface without either shipping on
 * the agent surfaces or carrying an explicit, ADR-cited exclusion.
 * Surface string conventions:
 * - cli:    the command line as typed ("opensesame task terminate",
 *           "opensesame-id claim poll"); apps/cli and packages/cli parity
 *           tests assert the tokens exist in the clap/arg-parser sources.
 * - pwa:    "lib|vault-core/<file>.ts:<export>" for an app core, shell or
 *           kernel seam the pages sweep import-checks, or "route:/section[/sub]"
 *           for a pages route.
 * - mcp_host / mcp_client: the MCP tool name on that server.
 * - webmcp: the document.modelContext tool name the Pages PWA registers.
 * - extension: "message:<type>" the browser extension's background handles.
 * - android: the Android app's intent or screen.
 *
 * Every surface of every capability is mapped, excluded with an ADR, or a
 * known gap recorded in `surface-gaps.json` (ADR 0139). A new gap is a diff
 * to that ledger, never a silent null.
 */

import { SCOPED_AGENT_ONLY, lifecycleCapabilities } from "./lifecycle.js";
import { securityAuthorityCapabilities } from "./security-authority.js";
import { transportSecurityCapabilities } from "./transport-security.js";
import { vaultCapabilities } from "./vault.js";
import { walletSpendingCapabilities } from "./wallet-spending.js";
export {
  AGENT_SECRET_NAME_PATTERN,
  assertsNoSecretNames,
} from "./secret-names.js";
export {
  INTERACTION_SETTLEMENT_PATTERN,
  assertsNoInteractionSettlementTool,
} from "./interaction-boundary.js";
export * from "./capability-map.js";

export type Surface =
  | "cli"
  | "pwa"
  | "mcp_host"
  | "mcp_client"
  | "webmcp"
  | "extension"
  | "android";

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
    /** `message:<type>` the browser extension's background handles. */
    readonly extension?: string | null;
    /** The Android app's intent or screen; absent means not built there. */
    readonly android?: string | null;
  };
  /**
   * null on a surface means "not applicable"; an entry here means
   * "deliberately withheld" and must cite a real ADR. The registry self-test
   * requires every host/identity capability to be mapped or excluded on MCP,
   * and every capability with a pwa surface to be mapped or excluded on
   * WebMCP.
   */
  readonly excluded?: Partial<Record<Surface, CapabilityExclusion>>;
}

export const CAPABILITIES: readonly Capability[] = [
  ...generalAuthorityCapabilities,
  ...accessPortalCapabilities,
  // ── Host plane: health, discovery, session ────────────────────────────
  {
    id: "host.health",
    title: "Host API and daemon health/readiness",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame status",
      pwa: null,
      mcp_host: "host_ready",
      mcp_client: "host_health",
      webmcp: null,
      extension: "message:opensesame.health",
    },
    excluded: { pwa: PAGES_HAS_NO_HOST, webmcp: PAGES_HAS_NO_HOST },
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
      webmcp: null,
    },
    excluded: { webmcp: PAGES_HAS_NO_HOST },
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
  ...nativeHostCapabilities,

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
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_client: SCOPED_AGENT_ONLY },
  },
  {
    id: "tasks.list",
    title: "List task runs",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame task list",
      pwa: null,
      mcp_host: "task_list",
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: PAGES_HAS_NO_HOST },
  },
  {
    id: "tasks.inspect",
    title: "Inspect a task run and its capability ceiling",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame task inspect",
      pwa: null,
      mcp_host: "task_status",
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: PAGES_HAS_NO_HOST },
  },
  {
    id: "tasks.terminate",
    title: "Terminate a task run",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame task terminate",
      pwa: null,
      mcp_host: "task_terminate",
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: PAGES_HAS_NO_HOST },
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
      mcp_host: "task_invoke_l1",
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
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: SCOPED_AGENT_ONLY, webmcp: PAGES_HAS_NO_HOST },
  },
  {
    id: "receipts.verify",
    title: "Verify a receipt signature",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame receipt verify",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
    },
  },
  ...sharedSessionCapabilities,
  ...transportSecurityCapabilities,
  ...enrollmentCapabilities,
  // ── Host plane: delegations, offers, relay ────────────────────────────
  {
    id: "delegations.list",
    title: "List delegations",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: SCOPED_AGENT_ONLY, webmcp: PAGES_HAS_NO_HOST },
  },
  {
    id: "delegations.offers.list",
    title: "List delegation offers",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: SCOPED_AGENT_ONLY, webmcp: PAGES_HAS_NO_HOST },
  },
  {
    id: "delegations.narrow",
    title: "Narrow a delegation (restriction only)",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: SCOPED_AGENT_ONLY, webmcp: PAGES_HAS_NO_HOST },
  },
  {
    id: "delegations.revoke",
    title: "Revoke a delegation",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: SCOPED_AGENT_ONLY, webmcp: PAGES_HAS_NO_HOST },
  },
  {
    id: "delegations.offers.revoke",
    title: "Revoke a delegation offer",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: SCOPED_AGENT_ONLY, webmcp: PAGES_HAS_NO_HOST },
  },
  {
    id: "delegations.offers.mint",
    title: "Mint a delegation offer (grant ceremony)",
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
      pwa: "lib/join/client.ts:claimInvite",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: HUMAN_CEREMONY,
      mcp_client: HUMAN_CEREMONY,
      webmcp: PAGES_HAS_NO_HOST,
    },
  },
  {
    id: "relay.inbox",
    title: "Read pending relay approval requests",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_host: SCOPED_AGENT_ONLY, webmcp: PAGES_HAS_NO_HOST },
  },
  {
    id: "relay.decide",
    title: "Approve or deny a relay request",
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
      mcp_host: HUMAN_CEREMONY,
      mcp_client: HUMAN_CEREMONY,
      webmcp: PAGES_HAS_NO_HOST,
    },
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
      webmcp: null,
    },
    // The gateway only exposes POST /api/v1/agent-identities (claim start);
    // there is no list/read route yet, so an MCP tool here could never
    // succeed. Map it once the gateway grows the read endpoint.
    excluded: {
      mcp_host: DEFERRED,
      mcp_client: DEFERRED,
      webmcp: PAGES_HAS_NO_HOST,
    },
  },

  // ── Host plane: providers, connections, integrations ──────────────────
  {
    id: "providers.list",
    title: "Browse the provider catalog",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame provider list",
      pwa: "lib/embedded-catalog.ts:getBundledProviders",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
      webmcp: DEFERRED,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_connections_read",
    },
    excluded: { mcp_client: SCOPED_AGENT_ONLY, mcp_host: SCOPED_AGENT_ONLY },
  },
  {
    id: "connections.inspect",
    title: "Inspect a connection and its activity",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame connect inspect",
      pwa: "lib/connections.ts:getConnection",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_connections_read",
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
      mcp_client: null,
      webmcp: null,
    },
    excluded: { mcp_client: SCOPED_AGENT_ONLY, webmcp: DEFERRED },
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
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_settings_read",
    },
    excluded: { mcp_client: SCOPED_AGENT_ONLY, mcp_host: SCOPED_AGENT_ONLY },
  },
  {
    id: "configs.audit",
    title: "Secret-config history and environment diff (metadata only)",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame config history",
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
    id: "configs.set",
    title: "Write a secret-config value (write-only intake)",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame config set",
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_settings_read",
    },
    excluded: { mcp_client: SCOPED_AGENT_ONLY, mcp_host: SCOPED_AGENT_ONLY },
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
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
  ...lifecycleCapabilities,
  ...securityAuthorityCapabilities,
  // ── Host plane: breach exposure (ADR 0080) ────────────────────────────
  {
    id: "security.findings.read",
    title: "Read breach findings for this organization",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame security findings",
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
    id: "security.breach_scan.trigger",
    title: "Run one breach scan now",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: "opensesame security scan",
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
    id: "ceremony.catalog.read",
    title: "Read which connector registrations this build can automate",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame ceremony list",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
      // Not a secret and not tenant data: the catalog is compiled in from
      // crates/ceremony/catalog.json and reads the same on every Host. The
      // WebMCP surface is pending rather than refused — apps/pages has no
      // ceremony screen yet, and a tool that names one would be a road nobody
      // configured.
      webmcp: {
        reason:
          "the PWA has no ceremony surface yet; mapping a WebMCP tool onto a screen that does not exist would offer a road that dead-ends",
        adr: ADR_CEREMONIES,
      },
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
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
      webmcp: SCOPED_AGENT_ONLY,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_settings_read",
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_settings_read",
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
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
    id: "identity.agent_auth.register",
    title: "Register an agent via auth.md AgentAuth",
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
      mcp_host: {
        reason:
          "AgentAuth is an OAuth HTTP profile agents speak directly with the Identity API; wrapping anonymous registration as a host MCP tool would mint principals inside another agent's session",
        adr: "0092-auth-md-agent-registration.md",
      },
      mcp_client: {
        reason:
          "AgentAuth is an OAuth HTTP profile agents speak directly with the Identity API; a client MCP tool is not the protocol surface",
        adr: "0092-auth-md-agent-registration.md",
      },
      webmcp: {
        reason:
          "AgentAuth is an OAuth HTTP profile agents speak directly with the Identity API; WebMCP must not mint anonymous registrations from a page session",
        adr: "0092-auth-md-agent-registration.md",
      },
    },
  },
  {
    id: "identity.claims.poll",
    title: "Poll a claim session",
    plane: "identity",
    kind: "read",
    surfaces: {
      cli: "opensesame-id claim poll",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_client: {
        reason:
          "Human Identity sessions and raw claim bearers are not agent capabilities or model arguments; use the human CLI or browser ceremony",
        adr: "0099-scoped-local-agent-authority.md",
      },
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
      pwa: "lib/federation.ts:beginSignIn",
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
    id: "identity.signout",
    title:
      "Sign out of this device: end the Identity session, forget the upstream assertion, lock the vault",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame logout",
      pwa: "lib/session-exit.ts:signOut",
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
    id: "identity.switch_account",
    title:
      "Switch account: sign out, then sign in afresh as somebody else (prompt=login on OIDC issuers)",
    plane: "identity",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/session-exit.ts:switchAccount",
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
  ...identityManagementCapabilities,
  ...connectorDirectoryCapabilities,
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
      pwa: "route:/device",
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
      webmcp: APPROVAL_CEREMONY,
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
      webmcp: APPROVAL_CEREMONY,
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
  ...vaultCapabilities,
  ...walletSpendingCapabilities,
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
    id: "vaults.switch",
    title: "Switch between the vaults on this device, seal or delete one",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vaults.ts:switchVault",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: DEVICE_VAULT_CEREMONY,
      mcp_client: DEVICE_VAULT_CEREMONY,
      webmcp: DEVICE_VAULT_CEREMONY,
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
    id: "vault.second_step.code",
    title:
      "Add, use or remove a one-time code by email or text as the vault's second step",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vault/remote-code.ts:sendCode",
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
    id: "vault.recovery_codes",
    title: "Make, view or redeem the vault's recovery codes",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/vault/unlock-methods.ts:randomRecoveryCodes",
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
  ...itemTypeCapabilities,
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
  // ── Client-local plane: in-product guidance ───────────────────────────
  {
    id: "client.support",
    title: "In-product contextual support conversation",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_help",
    },
    excluded: {
      mcp_host: IN_PAGE_GUIDANCE_ONLY,
      mcp_client: IN_PAGE_GUIDANCE_ONLY,
    },
  },
  {
    id: "client.command_bar",
    title: "Shell command omnibox (typed + mic STT)",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/command-bar/execute.ts:executeCommand",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: COMMAND_BAR_HUMAN_ONLY },
  },
  {
    id: "client.tutorial",
    title: "Named in-product walkthroughs",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/",
      mcp_host: null,
      mcp_client: null,
      webmcp: "opensesame_guide_start",
    },
    excluded: {
      mcp_host: IN_PAGE_GUIDANCE_ONLY,
      mcp_client: IN_PAGE_GUIDANCE_ONLY,
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
    title: "Deployment setup ceremony (optional, never a gate — ADR 0090)",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/setup.ts:completeSetup",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: FIRST_RUN_CEREMONY },
  },
] as const;

export * from "./surfaces.js";
