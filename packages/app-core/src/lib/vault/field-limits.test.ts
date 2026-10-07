import { describe, expect, it } from "vitest";
import { FIELD_LIMITS, clampTypedPath, isFolderPath } from "./field-limits.js";

describe("field limits", () => {
  it("accepts folder paths a vault can hold and refuses the rest", () => {
    expect(isFolderPath("Work")).toBe(true);
    expect(isFolderPath("Work/Taxes/2026")).toBe(true);
    expect(isFolderPath("测试/🔑")).toBe(true);
    for (const path of [
      "",
      "/Work",
      "Work/",
      "Work//Taxes",
      "Work/./Taxes",
      "Work/../Taxes",
      "Work\\Taxes",
      "Work\u0000",
      "s".repeat(FIELD_LIMITS.name + 1),
      Array.from({ length: 4 }, () => "s".repeat(FIELD_LIMITS.name)).join("/"),
    ])
      expect(isFolderPath(path), JSON.stringify(path)).toBe(false);
  });

  it("holds a typed path's leaf and prefix to their own limits", () => {
    expect(clampTypedPath("plain")).toBe("plain");
    const leaf = "l".repeat(FIELD_LIMITS.name + 10);
    expect(clampTypedPath(leaf)).toHaveLength(FIELD_LIMITS.name);
    expect(clampTypedPath(`a/b/${leaf}`)).toBe(
      `a/b/${"l".repeat(FIELD_LIMITS.name)}`,
    );
    const prefix = `${"p".repeat(FIELD_LIMITS.folder + 20)}/`;
    expect(clampTypedPath(`${prefix}leaf`)).toBe(
      `${"p".repeat(FIELD_LIMITS.folder)}leaf`,
    );
  });
});
