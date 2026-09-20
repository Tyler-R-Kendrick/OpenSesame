import { describe, expect, it } from "vitest";
import { lookupConfigResource } from "../../lib/configuration/registry.js";
import { settingsPageTree } from "./page-tree.js";

describe("settingsPageTree", () => {
  it.skip("lists each settings section once, on its own path", () => {
    const leaves = settingsPageTree().flatMap((node) => node.children);
    const hrefs = leaves.map((node) => node.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(leaves.map((node) => node.label)).toEqual([
      "General",
      "Connections",
      "Security",
      "Danger",
    ]);
    expect(hrefs).toContain("/settings");
    expect(hrefs).toContain("/settings/security");
    expect(lookupConfigResource("settings/prefs.yaml").ok).toBe(true);
  });
});
