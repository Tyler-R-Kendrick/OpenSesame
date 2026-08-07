import { describe, expect, it } from "vitest";

describe("mobile-mfa", () => {
  it("defaults identity api port documentation", () => {
    expect("http://127.0.0.1:8788").toContain("8788");
  });
});
