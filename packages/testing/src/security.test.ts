import { describe, expect, it } from "vitest";
import { assertNoSentinels, sentinelValues } from "./sentinels.js";

describe("security sentinels", () => {
  it("exports claim/token sentinels", () => {
    expect(sentinelValues.length).toBeGreaterThan(0);
  });

  it("passes clean logs", () => {
    expect(() => assertNoSentinels("claim completed id=clm_x")).not.toThrow();
  });

  it("fails when claim secret leaks", () => {
    expect(() => assertNoSentinels(`token=${sentinelValues[0]}`)).toThrow(
      /sentinel/,
    );
  });
});
