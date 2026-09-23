/**
 * Legacy configuration review (ownership.md §3, S19).
 *
 * Installations that predate composition carry records of functions they
 * used: providers in `settings.v1`, a setup ceremony in `setup.v1`, a model
 * provider, a connector directory endpoint. This module reads those records
 * and names the optional capabilities they *suggest* — so the consent UI can
 * offer them as pre-ticked draft items. It enables nothing. A skipped setup
 * tab, an endpoint URL, or a remembered provider is evidence that something
 * was configured, never consent to run it now.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvGet, kvHydrate } from "../kv.js";
import { runtimeConfigSnapshot } from "../runtime-config.js";
import { loadSettings } from "../settings.js";
import { loadSetup } from "../setup.js";

export type LegacySource =
  | "setup.v1"
  | "settings.v1"
  | "model-provider.v1"
  | "connector-directory.v1"
  | "os-runtime-config.json";

export type LegacySuggestion = Readonly<{
  capability: string;
  source: LegacySource;
  /** Authored, value-free description of what was found; never a URL or a name. */
  evidence: string;
}>;

export type LegacyReview = Readonly<{
  suggestions: readonly LegacySuggestion[];
  /** Always empty: a review offers, it never enables. */
  enabled: readonly [];
}>;

/** Records the core boot no longer hydrates; read here on demand. */
const MODEL_PROVIDER_KEY = "model-provider.v1";
const DIRECTORY_KEY = "connector-directory.v1";

function readJson(key: string): BoundaryValue | undefined {
  const raw = kvGet(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as BoundaryValue;
  } catch {
    return undefined;
  }
}

function identitySuggestions(out: LegacySuggestion[]): void {
  const settings = loadSettings();
  if ((settings.signIn?.providers.length ?? 0) > 0) {
    out.push({
      capability: "identity.federation",
      source: "settings.v1",
      evidence: "an operator-configured identity provider is on record",
    });
  }
  if (settings.identityApi.trim()) {
    out.push({
      capability: "identity.federation",
      source: "settings.v1",
      evidence: "an Identity API endpoint is configured",
    });
  }
  const setup = loadSetup();
  if (setup?.ways.some((way) => way !== "builtin")) {
    out.push({
      capability: "identity.federation",
      source: "setup.v1",
      evidence:
        "the setup ceremony kept a provider besides the built-in broker",
    });
  }
}

function supportSuggestions(out: LegacySuggestion[]): void {
  const config = runtimeConfigSnapshot();
  if (config.endpoints.supportAgentUrl) {
    out.push({
      capability: "support.remote-ai",
      source: "os-runtime-config.json",
      evidence: "a remote support agent endpoint is deployed",
    });
  }
  const record = readJson(MODEL_PROVIDER_KEY);
  if (!isJsonObject(record) || !isString(record.kind)) return;
  if (record.kind === "hosted") {
    out.push({
      capability: "support.remote-ai",
      source: "model-provider.v1",
      evidence: "a hosted model provider was chosen",
    });
  } else if (record.kind === "local" || record.kind === "browser") {
    out.push({
      capability: "support.local-ai",
      source: "model-provider.v1",
      evidence: "a local or in-browser model was chosen",
    });
  }
}

function connectorSuggestions(out: LegacySuggestion[]): void {
  const record = readJson(DIRECTORY_KEY);
  if (
    isJsonObject(record) &&
    isString(record.endpoint) &&
    record.endpoint.trim()
  ) {
    out.push({
      capability: "connectors.external",
      source: "connector-directory.v1",
      evidence: "a connector directory endpoint is on record",
    });
  }
}

function dedupe(suggestions: readonly LegacySuggestion[]): LegacySuggestion[] {
  const seen = new Set<string>();
  const out: LegacySuggestion[] = [];
  for (const s of suggestions) {
    const key = `${s.capability}|${s.source}|${s.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.sort((a, b) =>
    a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0,
  );
}

/** Synchronous review over whatever is hydrated. Enables nothing. */
export function reviewLegacyConfiguration(): LegacyReview {
  const out: LegacySuggestion[] = [];
  identitySuggestions(out);
  supportSuggestions(out);
  connectorSuggestions(out);
  return { suggestions: dedupe(out), enabled: [] };
}

/** Hydrate the legacy records the core boot skips, then review. */
export async function loadLegacyReview(): Promise<LegacyReview> {
  try {
    await kvHydrate([MODEL_PROVIDER_KEY, DIRECTORY_KEY]);
  } catch {
    // Unreadable storage reads as nothing configured; the review still offers
    // only what it can see, and enables nothing either way.
  }
  return reviewLegacyConfiguration();
}
