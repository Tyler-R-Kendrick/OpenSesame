/**
 * Vault item types (ADR 0087) and the marketplaces they are found in
 * (ADR 0134). Listing, installing and reading a marketplace are the PWA's;
 * every agent surface is excluded, because an item type defines the shape a
 * human is then asked to fill in.
 */
import type { Capability, CapabilityExclusion } from "./index.js";

const ADR_ITEM_TYPE_PLUGINS = "0087-vault-item-type-plugins.md";

export const ITEM_TYPE_HUMAN_CEREMONY: CapabilityExclusion = {
  reason:
    "an item type defines the shape a human is then asked to fill in; an agent that could install or enumerate one could shape that prompt",
  adr: ADR_ITEM_TYPE_PLUGINS,
};

export const itemTypeCapabilities: readonly Capability[] = [
  {
    id: "vault.item_types.list",
    title: "List the item types registered on this device",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "vault-core/item-types.ts:itemTypeRegistry",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { webmcp: ITEM_TYPE_HUMAN_CEREMONY },
  },
  {
    id: "vault.item_types.install",
    title: "Install or remove a vault item type definition",
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
      mcp_host: ITEM_TYPE_HUMAN_CEREMONY,
      mcp_client: ITEM_TYPE_HUMAN_CEREMONY,
      webmcp: ITEM_TYPE_HUMAN_CEREMONY,
    },
  },
  {
    id: "vault.item_types.marketplace",
    title:
      "Read an item-type marketplace from a git repository a person listed",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/settings",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: ITEM_TYPE_HUMAN_CEREMONY,
      mcp_client: ITEM_TYPE_HUMAN_CEREMONY,
      webmcp: ITEM_TYPE_HUMAN_CEREMONY,
    },
  },
];
