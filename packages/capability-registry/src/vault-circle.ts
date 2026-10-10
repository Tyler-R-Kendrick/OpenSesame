import type { Capability, CapabilityExclusion } from "./index.js";

const ADR_TRUSTED_CIRCLE = "0186-trusted-circle-quorum-sharing.md";

/**
 * The exit door of a trusted-contacts circle (ADR 0186): the native binary
 * recombines the guardians' SLIP-0039 shares and opens the owner's recovery
 * bundle with no browser. The shares and the recovered payload are a recovery
 * secret, so this is a person at a terminal and nothing an agent is handed:
 * shares are read from a file or stdin, the payload goes to an owner-only file.
 */
const HUMAN_RECOVERY: CapabilityExclusion = {
  reason:
    "recovering a trusted-contacts circle takes the guardians' shares and yields the recovery secret's payload; it is a person's act at a terminal, never an agent tool",
  adr: ADR_TRUSTED_CIRCLE,
};

const HUMAN_PREPARATION: CapabilityExclusion = {
  reason:
    "it checks a recovery bundle for a person who is about to recover a circle by hand; recovery is a human act at a terminal, and no agent tool is pointed at a recovery bundle",
  adr: ADR_TRUSTED_CIRCLE,
};

const EXIT_DOOR_ONLY: CapabilityExclusion = {
  reason:
    "the exit door for when the browser is not there: the browser's own recovery is the sharing.trusted-contacts ceremony, which has no screens yet; this surface does not recover a circle",
  adr: ADR_TRUSTED_CIRCLE,
};

const NOT_A_RECOVERY_SURFACE: CapabilityExclusion = {
  reason:
    "a terminal verb for a person with a recovery bundle on disk; the browser extension and the Android app do not recover a circle",
  adr: ADR_TRUSTED_CIRCLE,
};

const excluded = (
  human: CapabilityExclusion,
): NonNullable<Capability["excluded"]> => ({
  mcp_host: human,
  mcp_client: human,
  webmcp: human,
  pwa: EXIT_DOOR_ONLY,
  extension: NOT_A_RECOVERY_SURFACE,
  android: NOT_A_RECOVERY_SURFACE,
});

export const vaultCircleCapabilities: readonly Capability[] = [
  {
    id: "vault.circle.recover",
    title:
      "Recover a trusted-contacts circle's payload from its shares without a browser",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame vault circle recover",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: excluded(HUMAN_RECOVERY),
  },
  {
    id: "vault.circle.inspect",
    title:
      "Verify a recovery bundle's owner signature and show the circle's public shape",
    plane: "client_local",
    kind: "read",
    surfaces: {
      cli: "opensesame vault circle inspect",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: excluded(HUMAN_PREPARATION),
  },
];
