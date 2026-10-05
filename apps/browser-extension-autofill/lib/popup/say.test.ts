import { describe, expect, it } from "vitest";
import { describeOutcome, toneOf } from "./say";

describe("the popup's words for an outcome", () => {
  it("says a peppered password is skipped, as a warning, and names no secret", () => {
    expect(describeOutcome("needs_pepper")).toBe(
      "This password needs a pepper. Open it in the vault to use it",
    );
    expect(toneOf("needs_pepper")).toBe("warn");
  });
});
