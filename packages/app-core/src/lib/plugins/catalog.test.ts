import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type JsonValue,
  isBoolean,
  readJsonObject,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { PLUGIN_DAEMON_PURPOSE } from "../capabilities/catalog-optional-plugins.js";
import { CAPABILITY_CATALOG } from "../capabilities/catalog.js";
import { FEATURES, featureOf } from "../capabilities/features.js";
import { PRESETS } from "../capabilities/presets.js";
import { PLUGINS, isPluginId, pluginForCapability } from "./catalog.js";

const here = dirname(fileURLToPath(import.meta.url));

type SpecPlugin = {
  id: string;
  kind: string;
  capability: string;
  /** `null` when the spec does not say false or true. */
  defaultEnabled: boolean | null;
};

function specPlugins(): SpecPlugin[] {
  const parsed: JsonValue = JSON.parse(
    readFileSync(
      join(here, "../../../../../spec/plugins/catalog.json"),
      "utf8",
    ),
  );
  const raw = readJsonObject(parsed);
  if (raw === undefined || !Array.isArray(raw.plugins))
    throw new Error("spec/plugins/catalog.json has no plugins list");
  return raw.plugins.map((entry) => {
    const plugin = readJsonObject(entry);
    const flag = plugin?.default_enabled;
    return {
      id: String(plugin?.id),
      kind: String(plugin?.kind),
      capability: String(plugin?.capability),
      defaultEnabled: isBoolean(flag) ? flag : null,
    };
  });
}

const descriptor = (id: string) =>
  CAPABILITY_CATALOG.capabilities.find((entry) => entry.id === id);

describe("one plugin catalog (ADR 0139, ADR 0150 §7)", () => {
  it("mirrors spec/plugins/catalog.json exactly: ids, kinds and capabilities", () => {
    const spec = specPlugins().map(({ id, kind, capability }) => ({
      id,
      kind,
      capability,
    }));
    expect(
      PLUGINS.map(({ id, kind, capability }) => ({ id, kind, capability })),
    ).toEqual(spec);
  });

  it("every spec plugin is off by default", () => {
    for (const plugin of specPlugins())
      expect(plugin.defaultEnabled, plugin.id).toBe(false);
  });

  it("every spec plugin's capability is an optional descriptor, never always-on or core", () => {
    for (const plugin of specPlugins()) {
      const entry = descriptor(plugin.capability);
      expect(entry, plugin.capability).toBeDefined();
      expect(entry?.tier, plugin.capability).toBe("optional");
      expect(entry?.moduleIds[0]).toBe(`${plugin.capability}/runtime`);
    }
  });

  it("and vice versa: a capability that draws a plugin is one the spec lists", () => {
    const spec = new Set(specPlugins().map((plugin) => plugin.capability));
    for (const entry of CAPABILITY_CATALOG.capabilities) {
      if (pluginForCapability(entry.id) === null) continue;
      expect(spec.has(entry.id), entry.id).toBe(true);
    }
    // Every descriptor that talks to the plugin daemon draws a plugin.
    for (const entry of CAPABILITY_CATALOG.capabilities) {
      const daemon = entry.egress.some(
        (egress) => egress.purpose === PLUGIN_DAEMON_PURPOSE,
      );
      if (daemon) expect(spec.has(entry.id), entry.id).toBe(true);
    }
  });

  it("each plugin capability is one Capabilities section with a switch, backing nothing always-on", () => {
    for (const plugin of PLUGINS) {
      const section = featureOf(plugin.capability);
      expect(section?.capabilities, plugin.id).toEqual([plugin.capability]);
      for (const feature of FEATURES)
        expect(feature.backedBy ?? [], feature.id).not.toContain(
          plugin.capability,
        );
    }
  });

  it("no preset pre-selects a plugin capability", () => {
    for (const preset of PRESETS) {
      for (const plugin of PLUGINS) {
        expect(preset.defaultSelected, preset.id).not.toContain(
          plugin.capability,
        );
        expect(preset.required, preset.id).not.toContain(plugin.capability);
      }
    }
  });

  it("knows only the catalog's ids", () => {
    expect(isPluginId("surrogate-proxy")).toBe(true);
    expect(isPluginId("browser-autofill")).toBe(true);
    expect(isPluginId("__proto__")).toBe(false);
    expect(isPluginId("surrogate-proxy ")).toBe(false);
  });
});
