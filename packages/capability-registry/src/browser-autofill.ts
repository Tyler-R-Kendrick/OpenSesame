import { PAGES_HAS_NO_HOST } from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./types.js";

/**
 * Autofill by reference (ADR 0150 §6.4): the optional `browser-autofill`
 * plugin (§7). Its surfaces are the companion extension
 * `@opensesame/browser-extension-autofill` and the daemon's `/v1/fill*`
 * routes, which answer only while the plugin is switched on — never the
 * default extension, never Pages, never a model.
 */
export const ADR_SURROGATES = "0150-surrogate-credentials-at-the-last-hop.md";

/** The catalog id in `spec/plugins/catalog.json`. */
export const BROWSER_AUTOFILL_PLUGIN = "browser-autofill";

/** The gesture is the authorization; no model may make it. */
export const MODEL_NEVER_FILLS: CapabilityExclusion = {
  reason:
    "a fill follows a person's gesture on extension UI; no model triggers one",
  adr: ADR_SURROGATES,
};

const FILL_NEEDS_A_PAGE: CapabilityExclusion = {
  reason: "a terminal has no page to fill",
  adr: ADR_SURROGATES,
};

const PAGES_DOES_NOT_FILL: CapabilityExclusion = {
  reason: "only the companion extension fills",
  adr: ADR_SURROGATES,
};

const COMPANION_EXTENSION_ONLY: CapabilityExclusion = {
  reason: "the plugin is a browser extension only",
  adr: ADR_SURROGATES,
};

const PERSON_APPROVES_PAIRING: CapabilityExclusion = {
  reason: "a person approves the pairing code",
  adr: ADR_SURROGATES,
};

export const browserAutofillCapabilities: readonly Capability[] = [
  {
    id: "vault.autofill.fill",
    title:
      "Fill a focused login field by reference from the companion extension",
    plane: "host",
    kind: "act",
    plugin: BROWSER_AUTOFILL_PLUGIN,
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
      extension: "message:opensesame.fill",
      android: null,
    },
    excluded: {
      cli: FILL_NEEDS_A_PAGE,
      pwa: PAGES_DOES_NOT_FILL,
      mcp_host: MODEL_NEVER_FILLS,
      mcp_client: MODEL_NEVER_FILLS,
      webmcp: MODEL_NEVER_FILLS,
      android: COMPANION_EXTENSION_ONLY,
    },
  },
  {
    id: "vault.autofill.pairing",
    title: "Pair the companion autofill extension with this computer",
    plane: "host",
    kind: "ceremony",
    plugin: BROWSER_AUTOFILL_PLUGIN,
    surfaces: {
      cli: "opensesame daemon fill approve",
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
      extension: "message:opensesame.fill.pair",
      android: null,
    },
    excluded: {
      pwa: PAGES_HAS_NO_HOST,
      mcp_host: PERSON_APPROVES_PAIRING,
      mcp_client: PERSON_APPROVES_PAIRING,
      webmcp: PERSON_APPROVES_PAIRING,
      android: COMPANION_EXTENSION_ONLY,
    },
  },
];
