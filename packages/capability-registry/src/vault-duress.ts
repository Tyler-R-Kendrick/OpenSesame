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

const TRAP_OWNER_ONLY: CapabilityExclusion = {
  reason:
    "enrolling, removing or clearing retired credential traps requires fresh owner authentication; agents never acquire password history or arm deception",
  adr: "0181-retired-credential-traps.md",
};
const OBSERVATION_OWNER_ONLY: CapabilityExclusion = {
  reason:
    "canary enrollment and receiver pairing require fresh real-owner authentication; agents cannot change detection or its external destination",
  adr: "0181-retired-credential-traps.md",
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
  {
    id: "vaults.retired_credentials",
    title:
      "Retired credentials: enroll bounded detection traps and optional synthetic decoys",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id vault retired-credentials enroll",
      pwa: "lib/retired-credentials/index.ts:enrollRetiredCredential",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: TRAP_OWNER_ONLY,
      mcp_client: TRAP_OWNER_ONLY,
      webmcp: TRAP_OWNER_ONLY,
    },
  },
  {
    id: "vaults.controlled_canaries",
    title:
      "Controlled canaries: enroll synthetic artifacts and retired issuer generations",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id security canary create",
      pwa: "lib/credential-canaries/index.ts:createControlledCanary",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: OBSERVATION_OWNER_ONLY,
      mcp_client: OBSERVATION_OWNER_ONLY,
      webmcp: OBSERVATION_OWNER_ONLY,
    },
  },
  {
    id: "vaults.observation_receiver",
    title:
      "Observation receiver: pair and test independent sealed metadata delivery",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame-id security receiver configure",
      pwa: "lib/credential-observation/index.ts:configureObservationReceiver",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: OBSERVATION_OWNER_ONLY,
      mcp_client: OBSERVATION_OWNER_ONLY,
      webmcp: OBSERVATION_OWNER_ONLY,
    },
  },
  {
    id: "vaults.native_canary_detector",
    title:
      "Native canary detector: install a synthetic validator without real vault authority",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: "opensesame canary install",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      pwa: {
        reason:
          "the browser exports a canary configuration; installing its independent native stdio detector requires a human ceremony in that native environment",
        adr: "0181-retired-credential-traps.md",
      },
      mcp_host: OBSERVATION_OWNER_ONLY,
      mcp_client: OBSERVATION_OWNER_ONLY,
      webmcp: OBSERVATION_OWNER_ONLY,
    },
  },
];
