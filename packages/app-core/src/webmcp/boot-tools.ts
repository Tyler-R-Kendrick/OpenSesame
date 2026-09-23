/**
 * The tools that exist for as long as the WebMCP surface is mounted —
 * status, navigation and connectivity — owned by `agents.webmcp` itself. They
 * read only the vault store's public snapshot, the connectivity monitor and
 * the configured Identity API base; never an item, never a secret.
 */

import { activeItems } from "@opensesame/vault-core";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import {
  type TargetState,
  connectivitySnapshot,
} from "../lib/connectivity-monitor.js";
import { isOnline } from "../lib/connectivity.js";
import { currentSession, identityBase } from "../lib/identity.js";
import { vaultStore } from "../lib/vault/store.js";
import {
  SECTION_PATHS,
  navigationPaths,
  navigationTool,
} from "./navigation.js";
import type { PagesWebMcpTool } from "./tool-shared.js";

function targetSummary(state: TargetState) {
  return {
    health: state.health,
    rttMs: state.rttMs,
    lastCheckedAt: state.lastCheckedAt,
  } as const;
}

const statusTool: PagesWebMcpTool = {
  name: "opensesame_status",
  capabilityIds: ["app.status"],
  scope: "boot",
  readOnly: true,
  description:
    "Vault and session status for the OpenSesame authority vault: lock state, item and folder counts, storage durability, and whether an identity session is active. Never returns secret material.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: () => {
    const snapshot = vaultStore.getSnapshot();
    const live = activeItems(snapshot.items);
    return {
      vault: snapshot.status,
      durable: snapshot.durable,
      items: live.length,
      trashed: snapshot.items.length - live.length,
      folders: snapshot.folders.length,
      identitySignedIn: currentSession() !== null,
      sections: [...SECTION_PATHS],
      destinations: navigationPaths(),
    };
  },
};

const navigateTool: PagesWebMcpTool = {
  ...(navigationTool satisfies WebMcpToolSpec),
  capabilityIds: ["app.navigate"],
  scope: "boot",
};

const healthTool: PagesWebMcpTool = {
  name: "opensesame_health",
  capabilityIds: ["identity.health.pages"],
  scope: "boot",
  readOnly: true,
  description:
    "Connectivity posture of this vault tab: browser online state and last-probed health of the sign-in service.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  execute: () => {
    const snapshot = connectivitySnapshot();
    return {
      online: isOnline(),
      offline: snapshot.offline,
      identityApi: identityBase(),
      identity: targetSummary(snapshot.identity),
    };
  },
};

export const BOOT_TOOLS: readonly PagesWebMcpTool[] = [
  statusTool,
  navigateTool,
  healthTool,
];
