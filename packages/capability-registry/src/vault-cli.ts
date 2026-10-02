import { NEVER_AGENT_SECRET } from "./exclusions.js";
import type { Capability } from "./index.js";

/**
 * The item commands the Pages vault already offers, on `opensesame-id`.
 * Each one asks a person for the master password at a terminal. Copy, set,
 * and share can carry a secret value, so no agent surface gets them.
 */
const HUMAN_VAULT_VALUE = {
  mcp_host: NEVER_AGENT_SECRET,
  mcp_client: NEVER_AGENT_SECRET,
  webmcp: NEVER_AGENT_SECRET,
} as const;

export const vaultCliCapabilities: readonly Capability[] = [
  {
    id: "vault.item.create",
    title: "Create a vault item",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame-id vault new",
      pwa: "route:/vault",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: HUMAN_VAULT_VALUE,
  },
  {
    id: "vault.item.set",
    title: "Edit a vault item's name, username, or secret",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame-id vault set",
      pwa: "route:/vault",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: HUMAN_VAULT_VALUE,
  },
  {
    id: "vault.item.share",
    title: "Share a secret once",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id vault share",
      pwa: "lib/vault/drop.ts:createDrop",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: HUMAN_VAULT_VALUE,
  },
];
