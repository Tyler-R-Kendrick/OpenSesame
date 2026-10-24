import { describe, expect, it } from "vitest";
import { itemTypeHasFormatGenerator } from "./format-capabilities.js";
import { TYPED_FORMATS, formatsForType } from "./formats.js";
import { FORMAT_ITEM_TYPE_IDS, itemFormatCoverage } from "./registry.js";
import {
  DEFAULT_ROTATION_INTERVAL_DAYS,
  itemHasGenerator,
  itemRotationMode,
  itemRotationWarning,
} from "./rotation.js";

describe("item rotation capabilities", () => {
  it("marks the web login as the only provider-rotatable type", () => {
    expect(itemRotationMode("account")).toBe("automatic");
    expect(itemRotationMode("card")).toBe("manual");
    expect(itemRotationMode("note")).toBe("none");
  });

  it("uses one default schedule", () => {
    expect(DEFAULT_ROTATION_INTERVAL_DAYS).toBe(30);
  });

  it("warns on generator-backed types with no provider path", () => {
    expect(itemRotationWarning("card")).toMatch(/couldn't verify/u);
    expect(itemRotationWarning("account")).toBeNull();
    expect(itemRotationWarning("note")).toBeNull();
    expect(itemHasGenerator("card")).toBe(true);
    expect(itemHasGenerator("note")).toBe(false);
  });
});

describe("lightweight format capability metadata", () => {
  it("matches every real registered generator and coverage result", () => {
    const types = new Set([
      ...FORMAT_ITEM_TYPE_IDS,
      ...TYPED_FORMATS.map((format) => format.typeId),
      "unknown-format",
      "__proto__",
      "constructor",
      "",
    ]);
    for (const typeId of types) {
      const formats = formatsForType(typeId);
      const generated = formats.some((format) => format.generate !== undefined);
      expect(itemTypeHasFormatGenerator(typeId), typeId).toBe(generated);
      expect(itemFormatCoverage(typeId).status, typeId).toBe(
        formats.length === 0
          ? "unsupported"
          : generated
            ? "parser+generator"
            : "parser",
      );
      const expected =
        typeId === "account" ? "automatic" : generated ? "manual" : "none";
      expect(itemRotationMode(typeId), typeId).toBe(expected);
      expect(itemHasGenerator(typeId), typeId).toBe(expected !== "none");
      expect(itemRotationWarning(typeId) !== null, typeId).toBe(
        expected === "manual",
      );
    }
  });

  it("does not mistake automatic account rotation for a synthetic generator", () => {
    expect(itemTypeHasFormatGenerator("account")).toBe(false);
    expect(itemHasGenerator("account")).toBe(true);
    expect(itemRotationMode("certificate")).toBe("none");
    expect(itemTypeHasFormatGenerator("certificate")).toBe(false);
    expect(itemFormatCoverage("certificate").status).toBe("parser");
  });
});
