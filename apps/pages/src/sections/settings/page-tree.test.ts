import { describe, expect, it } from "vitest";
import { lookupConfigResource } from "../../lib/configuration/registry.js";
import { settingsPageTree } from "./page-tree.js";

describe("settingsPageTree", () => {
  it("projects prefs.yaml onto the existing Settings general page", () => {
    const tree = settingsPageTree();
    const prefs = tree
      .flatMap((node) => node.children)
      .find((node) => node.id === "prefs.yaml");
    expect(prefs?.href).toBe("/settings");
    expect(lookupConfigResource("settings/prefs.yaml").ok).toBe(true);
    expect(lookupConfigResource(".config/opensesame/prefs.yaml").ok).toBe(true);
  });
});
