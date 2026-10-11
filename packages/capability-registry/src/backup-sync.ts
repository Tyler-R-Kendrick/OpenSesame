import {
  ADR_TAILNET_SYNC,
  DEFERRED,
  OPS_PLANE,
  PAGES_HAS_NO_SYNC_TARGETS,
} from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./index.js";
import { SCOPED_AGENT_ONLY } from "./lifecycle.js";
import { tailnetDeviceCapabilities } from "./tailnet-devices.js";
import { trustedContactCapabilities } from "./trusted-contacts.js";

/**
 * Getting a vault off one device: the server-side backup posture (ADR 0039)
 * and tailnet vault sync (ADR 0144), where the daemon keeps one sealed
 * snapshot per slot and each device merges it under its own key. The same
 * daemon's tailnet device management (ADR 0169) rides at the end.
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
    // The Host reads its server-side target (ADR 0039); Pages reads the
    // browser-local target that replaced it there (ADR 0128's backup road),
    // drawn by Settings › Capabilities › Backups.
    title: "Read vault backup posture",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "lib/backup.ts:getBackupStatus",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: SCOPED_AGENT_ONLY,
      // No page tool reports the backup target; `opensesame_settings_read`
      // used to claim it and returned none of it.
      webmcp: DEFERRED,
    },
  },
  {
    id: "backup.target.set",
    // In Pages: bind a git provider and repository as the browser-local
    // target (a connector's backup form, the GitHub App repository picker).
    title: "Configure the vault backup target",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: "lib/backup.ts:putBackupTarget",
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
  // Host sync targets replicate the sealed store's ciphertext elsewhere
  // (ADR 0039's family). Pages has none (ADR 0128); its own backup is above.
  {
    id: "sync_targets.read",
    title: "Read replication sync targets",
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
      mcp_client: SCOPED_AGENT_ONLY,
      mcp_host: SCOPED_AGENT_ONLY,
      pwa: PAGES_HAS_NO_SYNC_TARGETS,
      webmcp: PAGES_HAS_NO_SYNC_TARGETS,
    },
  },
  {
    id: "sync_targets.trigger",
    title: "Trigger a sync-target replication run",
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
      mcp_host: DEFERRED,
      mcp_client: DEFERRED,
      pwa: PAGES_HAS_NO_SYNC_TARGETS,
      webmcp: PAGES_HAS_NO_SYNC_TARGETS,
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
      cli: "opensesame-id vault sync",
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
  ...tailnetDeviceCapabilities,
  ...trustedContactCapabilities,
];
