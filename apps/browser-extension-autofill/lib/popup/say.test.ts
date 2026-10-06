import { describe, expect, it } from "vitest";
import { describeOutcome, toneOf } from "./say";

describe("the popup's words for an outcome", () => {
  it("says a password with a pepper slot was filled as far as the slot, and names no secret", () => {
    expect(describeOutcome("pepper_next")).toBe(
      "Filled. Type your pepper where it goes",
    );
    expect(toneOf("pepper_next")).toBe("ok");
  });

  it("sends an earlier pepper's password to be converted, as a warning", () => {
    expect(describeOutcome("legacy_password")).toBe(
      "This password was made with an earlier pepper. Open it in the vault to convert it",
    );
    expect(toneOf("legacy_password")).toBe("warn");
  });
});
