import {
  EFFECTIVE_FILE,
  POLICY_FILE,
  SELECTION_FILE,
} from "@opensesame/app-core/sections/settings/capability-files.js";
import { describe, expect, it } from "vitest";
import { isSettingsDocument } from "./documents.js";

describe("isSettingsDocument", () => {
  it("names a directory's own config.yaml, by file name or by path", () => {
    for (const category of [
      "general",
      "security",
      "vaults",
      "features",
      "integrations",
    ]) {
      expect(isSettingsDocument(category, "config.yaml")).toBe(true);
      expect(
        isSettingsDocument(category, `settings/${category}/config.yaml`),
      ).toBe(true);
    }
  });

  it("names the capability documents in Features and nowhere else", () => {
    for (const path of [SELECTION_FILE, POLICY_FILE, EFFECTIVE_FILE]) {
      expect(isSettingsDocument("features", path)).toBe(true);
      expect(isSettingsDocument("integrations", path)).toBe(false);
      expect(isSettingsDocument("item-types", path)).toBe(false);
    }
  });

  it("leaves a file a provider keeps for authoring to the viewer", () => {
    expect(
      isSettingsDocument(
        "item-types",
        "settings/item-types/installed/wifi.json",
      ),
    ).toBe(false);
    expect(
      isSettingsDocument("item-types", "settings/item-types/marketplaces.json"),
    ).toBe(false);
    expect(isSettingsDocument("features", "settings/features/other.yaml")).toBe(
      false,
    );
  });
});
