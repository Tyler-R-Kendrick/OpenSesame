import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * Travel mode (ADR 0143): the vaults not safe to carry leave the device in a
 * bundle under a return code the traveller does not carry, and come back
 * from both. Which vaults leave, and bringing them home, is the person's
 * decision before and after a border; an agent that could do either could
 * strip the device or undo the protection the traveller chose.
 */
const TRAVELLER_ONLY: CapabilityExclusion = {
  reason:
    "sending vaults off the device and bringing them home is the traveller's own decision; an agent in one open vault never moves tombs or holds a return code",
  adr: "0143-travel-mode.md",
};

const TRAVELLER_ITEMS_ONLY: CapabilityExclusion = {
  reason:
    "choosing which items leave an open vault for a trip, and bringing them back, is the traveller's own decision; an agent that could do either could strip a vault or undo the protection the traveller chose, and never holds a return code",
  adr: "0171-hide-items-while-traveling.md",
};

export const vaultTravelCapabilities: readonly Capability[] = [
  {
    id: "vaults.travel",
    title:
      "Travel mode: send the vaults not safe for travel off this device, and bring them home",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/travel/index.ts:packTravelDeparture",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: TRAVELLER_ONLY,
      mcp_client: TRAVELLER_ONLY,
      webmcp: TRAVELLER_ONLY,
    },
  },
  {
    id: "vaults.travel_items",
    title:
      "Travel mode: leave chosen items of the open vault at home in a bundle under a return code, and bring them back",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/travel/index.ts:packTravelItemDeparture",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: TRAVELLER_ITEMS_ONLY,
      mcp_client: TRAVELLER_ITEMS_ONLY,
      webmcp: TRAVELLER_ITEMS_ONLY,
    },
  },
];
