import { FEATURES } from "@opensesame/app-core/lib/capabilities/features.js";
import { describe, expect, it } from "vitest";
import {
  capabilitiesSettingsSections,
  settingsPageSources,
  settingsPageTree,
} from "./page-tree.js";

describe("settingsPageTree", () => {
  it("lists each settings tab as a first-level child, never nested under another tab", () => {
    const tabs = settingsPageTree();
    // Connections is gone as a tab: every provider is configured on
    // Capabilities, under the feature (or always-on group) that uses it.
    expect(tabs.map((node) => node.label)).toEqual([
      "General",
      "Security",
      "Vaults",
      "Capabilities",
      "Danger",
    ]);
    expect(tabs.map((node) => node.href)).toEqual([
      "/settings",
      "/settings/security",
      "/settings/vaults",
      "/settings/capabilities",
      "/settings/danger",
    ]);
    for (const tab of tabs) {
      expect(tab.branch).toBe(true);
      if (tab.id === "vaults") continue;
      for (const child of tab.children) {
        expect(child.href.startsWith("/settings/vaults")).toBe(false);
      }
    }
    const capabilities = tabs.find((node) => node.id === "capabilities");
    expect(capabilities?.children.map((node) => node.label)).toEqual(
      capabilitiesSettingsSections().map((section) => section.label),
    );
  });

  it("names the Capabilities sections: guests, then every section once", () => {
    expect(capabilitiesSettingsSections().map((s) => s.label)).toEqual([
      "Guests",
      ...FEATURES.map((feature) => feature.title),
    ]);
    expect(capabilitiesSettingsSections()[1]?.href).toBe(
      "/settings/capabilities#feature-identity",
    );
    // The operator's section is listed only where it draws.
    expect(
      capabilitiesSettingsSections(true, true)
        .map((s) => s.label)
        .at(-1),
    ).toBe("Instance policy");
  });

  it("mirrors vaults on this device under the Vaults tab only, then Travel", () => {
    const tabs = settingsPageTree({
      vaults: [
        { id: "personal", label: "personal" },
        { id: "proj-1", label: "project · 4f2a" },
      ],
    });
    const vaults = tabs.find((node) => node.id === "vaults");
    expect(vaults?.children.map((node) => node.label)).toEqual([
      "personal",
      "project · 4f2a",
      "Travel",
    ]);
    const capabilities = tabs.find((node) => node.id === "capabilities");
    expect(capabilities?.children.map((node) => node.label)).not.toContain(
      "personal",
    );
  });

  it("keeps sources in tab order without a synthetic Settings wrapper", () => {
    expect(settingsPageSources().map((source) => source.id)).toEqual([
      "general",
      "security",
      "vaults",
      "capabilities",
      "danger",
    ]);
  });

  it("names General › Install only when the panel draws", () => {
    const general = (install: boolean) =>
      settingsPageTree({ install })
        .find((node) => node.id === "general")
        ?.children.map((node) => node.label);
    // A rail entry for a panel that returned null opened General at its
    // top with nothing to show for it.
    expect(general(false)).toEqual([]);
    expect(general(true)).toEqual(["Install"]);
  });
});
