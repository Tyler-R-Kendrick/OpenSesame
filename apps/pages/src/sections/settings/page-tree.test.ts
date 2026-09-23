import { registerLegacySettingsCategories } from "@opensesame/app-core/lib/contributions.test-support.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectionsSettingsSections,
  settingsPageSources,
  settingsPageTree,
} from "./page-tree.js";

describe("settingsPageTree", () => {
  // Connections is the connectors capability's settings category, so it is
  // on the tree only where that capability is approved. These cases describe
  // such a deployment and register the contribution the module makes.
  let revokeCategories: (() => void) | null = null;
  beforeEach(() => {
    revokeCategories = registerLegacySettingsCategories();
  });
  afterEach(() => {
    revokeCategories?.();
    revokeCategories = null;
  });

  it("lists each settings tab as a first-level child, never nested under another tab", () => {
    const tabs = settingsPageTree();
    expect(tabs.map((node) => node.label)).toEqual([
      "General",
      "Security",
      "Vaults",
      "Connections",
      "Capabilities",
      "Danger",
    ]);
    expect(tabs.map((node) => node.href)).toEqual([
      "/settings",
      "/settings/security",
      "/settings/vaults",
      "/settings/connections",
      "/settings/capabilities",
      "/settings/danger",
    ]);
    for (const tab of tabs) {
      expect(tab.branch).toBe(true);
      if (tab.id === "vaults") continue;
      for (const child of tab.children) {
        expect(child.href.startsWith("/settings/vaults")).toBe(false);
        expect(child.label).not.toBe("Connections");
      }
    }
    const connections = tabs.find((node) => node.id === "connections");
    expect(connections?.children.map((node) => node.label)).toEqual(
      connectionsSettingsSections().map((section) => section.label),
    );
    expect(connections?.children.some((node) => node.label === "Core")).toBe(
      false,
    );
    expect(connections?.children.some((node) => node.label === "Project")).toBe(
      false,
    );
    const github = connections?.children
      .flatMap((node) => node.children)
      .find((node) => node.id === "github");
    expect(github?.href).toBe("/settings/connections/github");
  });

  it("mirrors vaults on this device under the Vaults tab only", () => {
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
    ]);
    const connections = tabs.find((node) => node.id === "connections");
    expect(connections?.children.map((node) => node.label)).not.toContain(
      "personal",
    );
  });

  it("keeps sources in tab order without a synthetic Settings wrapper", () => {
    expect(settingsPageSources().map((source) => source.id)).toEqual([
      "general",
      "security",
      "vaults",
      "connections",
      "capabilities",
      "danger",
    ]);
  });
});
