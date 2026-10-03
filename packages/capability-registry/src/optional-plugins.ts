import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * Optional plugins installed at runtime (ADR 0150 §7): the surrogate proxy
 * and the autofill companion extension ship in no default build. A person
 * installs one pinned by sha256, it is recorded off, and it runs only once
 * switched on — with `opensesame plugins`, or the daemon's `/v1/plugins`
 * routes that Settings reads under the plugin's catalog capability
 * (`agents.surrogate-credentials`, `vault.browser-autofill`).
 *
 * Settings › Capabilities reads and switches them on the daemon a person
 * paired (`lib/plugins/client.ts`) through one operation per plugin, so each
 * is owned by that plugin's product capability; installing and removing
 * stay at a terminal, never over HTTP.
 *
 * None of it is model-reachable: installing puts an executable on the
 * machine, switching one on changes what runs there, and a surrogate run
 * spawns processes and brokers credentials.
 */
export const ADR_SURROGATES = "0150-surrogate-credentials-at-the-last-hop.md";

const PLUGIN_EXECUTABLES_HUMAN: CapabilityExclusion = {
  reason: "changes which executables run here: a person decides, never a model",
  adr: ADR_SURROGATES,
};

const INSTALL_AT_A_TERMINAL: CapabilityExclusion = {
  reason: "install and remove are terminal-only; no daemon route installs",
  adr: ADR_SURROGATES,
};

const SURROGATE_RUN_HUMAN: CapabilityExclusion = {
  reason: "a surrogate run brokers a credential: never model-triggered",
  adr: ADR_SURROGATES,
};

const TRIPWIRES_NOT_FOR_THE_PROBER: CapabilityExclusion = {
  reason: "a prober must not learn which probes tripped",
  adr: ADR_SURROGATES,
};

const NO_PROCESSES_IN_PAGES: CapabilityExclusion = {
  reason: "a page spawns no processes",
  adr: ADR_SURROGATES,
};

const PAIRING_HUMAN: CapabilityExclusion = {
  reason:
    "pairing hands one browser origin a key to switch plugins on this machine; a person prints the code at the daemon's terminal and pastes it into that page, never a model",
  adr: ADR_SURROGATES,
};

const PER_PLUGIN_IN_PAGES: CapabilityExclusion = {
  reason: "Pages uses the per-plugin operations",
  adr: "0130-operator-controlled-capability-composition.md",
};

const AGENTS_EXCLUDED = (exclusion: CapabilityExclusion) => ({
  mcp_host: exclusion,
  mcp_client: exclusion,
  webmcp: exclusion,
});

export const optionalPluginCapabilities: readonly Capability[] = [
  {
    id: "plugins.read",
    title:
      "List optional plugins and one plugin's state and pin (GET /v1/plugins)",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame plugins list",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      ...AGENTS_EXCLUDED(PLUGIN_EXECUTABLES_HUMAN),
      pwa: PER_PLUGIN_IN_PAGES,
    },
  },
  {
    id: "plugins.install",
    title: "Install an optional plugin pinned by sha256, recorded off",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame plugins install",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      ...AGENTS_EXCLUDED(PLUGIN_EXECUTABLES_HUMAN),
      pwa: INSTALL_AT_A_TERMINAL,
    },
  },
  {
    id: "plugins.toggle",
    title: "Switch an installed plugin on or off (PUT /v1/plugins/{id})",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame plugins enable",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      ...AGENTS_EXCLUDED(PLUGIN_EXECUTABLES_HUMAN),
      pwa: PER_PLUGIN_IN_PAGES,
    },
  },
  {
    id: "plugins.remove",
    title: "Delete an optional plugin's installed files and its record",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame plugins remove",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      ...AGENTS_EXCLUDED(PLUGIN_EXECUTABLES_HUMAN),
      pwa: INSTALL_AT_A_TERMINAL,
    },
  },
  {
    id: "plugins.notices",
    title:
      "Read a plugin's recent tripwire notices, never a surrogate (GET /v1/plugins/{id}/notices)",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame plugins notices",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      ...AGENTS_EXCLUDED(TRIPWIRES_NOT_FOR_THE_PROBER),
      pwa: PER_PLUGIN_IN_PAGES,
    },
  },
  // Pairing a page with the daemon's plugin settings: the CLI prints a
  // one-time code bound to one origin; the page trades it for a key that
  // opens the plugin routes and nothing else (ADR 0150 §7).
  {
    id: "plugins.pair",
    title:
      "Pair one browser origin with the daemon's plugin settings (one-time code for a key scoped to /v1/plugins)",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame plugins pair",
      pwa: "lib/tailnet-sync/plugin-daemon.ts:tailnetPluginDaemon",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_EXCLUDED(PAIRING_HUMAN),
  },
  {
    id: "plugins.unpair",
    title:
      "Revoke a page's plugin-settings key: every pairing for an origin at the terminal, or this page's own from Settings",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame plugins unpair",
      pwa: "lib/tailnet-sync/plugin-daemon.ts:tailnetPluginDaemon",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_EXCLUDED(PAIRING_HUMAN),
  },
  {
    id: "agents.surrogate.dev_run",
    title:
      "Run a child with surrogates in place of placeholders and web-login passwords through the surrogate-proxy plugin",
    plane: "client_local",
    kind: "act",
    surfaces: {
      cli: "opensesame dev run",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      ...AGENTS_EXCLUDED(SURROGATE_RUN_HUMAN),
      pwa: NO_PROCESSES_IN_PAGES,
    },
  },
  // One switch per plugin, as Settings draws it: each plugin's section in
  // Settings › Capabilities carries its own switch and the CLI's
  // `plugins enable|disable <id>` is the same PUT (ADR 0150 §7).
  {
    id: "plugins.surrogate_proxy.switch",
    title: "Switch the surrogate proxy plugin on or off on the paired daemon",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame plugins enable",
      pwa: "lib/plugins/client.ts:setPluginEnabled",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_EXCLUDED(PLUGIN_EXECUTABLES_HUMAN),
  },
  {
    id: "plugins.surrogate_proxy.tripwires",
    title: "Read the surrogate proxy's recent tripwires",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: "opensesame plugins notices",
      pwa: "lib/plugins/client.ts:readPluginNotices",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_EXCLUDED(TRIPWIRES_NOT_FOR_THE_PROBER),
  },
  {
    id: "plugins.browser_autofill.switch",
    title:
      "Switch the autofill extension plugin on or off on the paired daemon",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: "opensesame plugins enable",
      pwa: "lib/plugins/client.ts:setPluginEnabled",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_EXCLUDED(PLUGIN_EXECUTABLES_HUMAN),
  },
];
