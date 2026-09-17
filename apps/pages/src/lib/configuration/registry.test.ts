import { describe, expect, it } from "vitest";
import { PREFS_PATH_ALIASES } from "./aliases.js";
import { PREFS_RESOURCE_KEY } from "./prefs-keys.js";
import { lookupConfigResource } from "./registry.js";

describe("lookupConfigResource ADV-01", () => {
  it("resolves every prefs alias to the same resource", () => {
    const keys = PREFS_PATH_ALIASES.map((alias) => lookupConfigResource(alias));
    expect(
      keys.every((item) => item.ok && item.resourceKey === PREFS_RESOURCE_KEY),
    ).toBe(true);
  });

  it("refuses traversal, encoded traversal, absolute paths, and ledgers", () => {
    const attacks = [
      ".config/../config/identity-grants",
      "..%2fconfig/identity-grants",
      "/etc/passwd",
      "config/identity-grants",
      "config/key-wrap",
      "tomb/personal/header",
      "config/index",
    ];
    for (const path of attacks) {
      const result = lookupConfigResource(path);
      expect(result.ok).toBe(false);
    }
  });
});
