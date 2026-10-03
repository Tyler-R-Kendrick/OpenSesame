import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * The device's duress code (ADR 0155): a second code that, typed where a
 * vault unlocks, shows a decoy or a refusal. A coerced person's own decision;
 * an agent that could set or clear it could arm a trap or disarm a defence.
 */
const OWNER_ONLY: CapabilityExclusion = {
  reason:
    "the code that changes what a coerced person's device shows, and clearing what it set off, is that person's own decision; an agent never arms, changes or clears it",
  adr: "0155-the-device-duress-code.md",
};

export const vaultDuressCapabilities: readonly Capability[] = [
  {
    id: "vaults.duress_code",
    title:
      "Duress code: a second unlock code that shows a decoy or a refusal, set and cleared by the owner",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/duress/settings/device-duress.ts:enableDuressCode",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: OWNER_ONLY,
      mcp_client: OWNER_ONLY,
      webmcp: OWNER_ONLY,
    },
  },
];
