import { ADR_TAILNET_SYNC, OPS_PLANE } from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./index.js";
import { SCOPED_AGENT_ONLY } from "./lifecycle.js";

/**
 * Getting a vault off one device: the server-side backup posture (ADR 0039)
 * and tailnet vault sync (ADR 0144), where the daemon keeps one sealed
 * snapshot per slot and each device merges it under its own key.
 */

/** Opening a slot mints its only key; the daemon refuses any browser request. */
const DRIVE_SLOTS_OPERATOR_ONLY: CapabilityExclusion = {
  reason:
    "opening a drive slot mints the key that reads and replaces a vault snapshot; the daemon serves slot routes to its operator only and refuses any browser request",
  adr: ADR_TAILNET_SYNC,
};

/** Pairing moves a vault between devices; nothing but its person decides that. */
const DRIVE_PAIRING_HUMAN: CapabilityExclusion = {
  reason:
    "pairing a vault with a drive copies it to every device that holds the code, and on a new device adopts it before unlock; only the person the vault belongs to decides that",
  adr: ADR_TAILNET_SYNC,
};

export const backupSyncCapabilities: readonly Capability[] = [
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
  {
    id: "vault.drive.slots",
    title: "Open, list and close tailnet vault drive slots",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame daemon drive create",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      pwa: DRIVE_SLOTS_OPERATOR_ONLY,
      webmcp: DRIVE_SLOTS_OPERATOR_ONLY,
      mcp_host: OPS_PLANE,
      mcp_client: OPS_PLANE,
    },
  },
  {
    id: "vault.drive.sync",
    title: "Pair the vault with a tailnet drive and keep it in step",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/tailnet-sync/observer.ts:pairTailnetDrive",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      webmcp: DRIVE_PAIRING_HUMAN,
      mcp_host: DRIVE_PAIRING_HUMAN,
      mcp_client: DRIVE_PAIRING_HUMAN,
    },
  },
];
