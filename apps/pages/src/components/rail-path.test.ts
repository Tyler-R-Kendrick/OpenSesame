import { describe, expect, it } from "vitest";
import { nextSectionOpen, rowSelected } from "./PageTreeBranch.js";

describe("shared rail branch helpers", () => {
  it("seeds open only by flipping the current section", () => {
    expect(nextSectionOpen(true, true)).toBe(false);
    expect(nextSectionOpen(true, false)).toBe(true);
    expect(nextSectionOpen(false, false)).toBe(true);
    expect(nextSectionOpen(false, true)).toBe(true);
  });

  it("selects a row by href or preview path", () => {
    expect(rowSelected("/vault?f=login", { href: "/vault?f=login" })).toBe(
      true,
    );
    expect(
      rowSelected("/connections#catalog-age", {
        href: "/connections/age",
        selectTo: "/connections#catalog-age",
      }),
    ).toBe(true);
    expect(rowSelected("/vault", { href: "/settings" })).toBe(false);
  });
});
