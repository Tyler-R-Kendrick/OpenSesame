/**
 * The optional, runtime-installed plugins Settings › Capabilities can show
 * (ADR 0150 §7) — the page's copy of `spec/plugins/catalog.json`, pinned to
 * it by a drift test (`catalog.test.ts`).
 *
 * Nothing a plugin does is in this bundle. A plugin is installed at a
 * terminal on the machine that runs the daemon, pinned by sha256, and off
 * until switched on. Pages only reads what the daemon says about it and asks
 * the daemon to switch it; the capability that draws that (`capability`)
 * is optional, never always-on, and loads only after consent (ADR 0130).
 *
 * Pure data: no fetch, no storage, no React.
 */

import type { CapabilityId } from "@opensesame/capability-composition";

export type PluginId = "surrogate-proxy" | "browser-autofill";

export type PluginKind = "native-binary" | "browser-extension";

export type PluginEntry = Readonly<{
  id: PluginId;
  kind: PluginKind;
  /** The Pages capability that draws it; one plugin, one capability. */
  capability: CapabilityId;
  /** What the panel calls it. */
  title: string;
  /**
   * The command a person runs at a terminal to install it, with `<…>` for
   * what only they know. `apps/cli` parses it with its own parser, so it
   * cannot drift from the verb's required arguments.
   */
  installCommand: string;
  /** The daemon keeps a tripwire feed for it (`GET /v1/plugins/{id}/notices`). */
  notices: boolean;
}>;

export const PLUGINS: readonly PluginEntry[] = [
  {
    id: "surrogate-proxy",
    kind: "native-binary",
    capability: "agents.surrogate-credentials",
    title: "Surrogate proxy",
    installCommand:
      "opensesame plugins install surrogate-proxy --from <file-or-url> --sha256 <sha256>",
    notices: true,
  },
  {
    id: "browser-autofill",
    kind: "browser-extension",
    capability: "vault.browser-autofill",
    title: "Autofill extension",
    installCommand:
      "opensesame plugins install browser-autofill --from <file-or-url> --sha256 <sha256> --extension-id <extension-id>",
    notices: false,
  },
];

const IDS: ReadonlySet<string> = new Set(PLUGINS.map((entry) => entry.id));

/** Whether a string names a plugin this page knows; nothing else is drawn. */
export function isPluginId(value: string): value is PluginId {
  return IDS.has(value);
}

export function pluginById(id: PluginId): PluginEntry {
  const found = PLUGINS.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown plugin ${id}`);
  return found;
}

/** The plugin a capability draws, or null for every other capability. */
export function pluginForCapability(id: CapabilityId): PluginEntry | null {
  return PLUGINS.find((entry) => entry.capability === id) ?? null;
}
