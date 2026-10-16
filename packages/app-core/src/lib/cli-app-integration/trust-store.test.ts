import { describe, expect, it } from "vitest";
import { compareRootTrustFingerprint } from "./trust-store.js";

describe("compareRootTrustFingerprint", () => {
  it("alarms on changed fingerprint", () => {
    const fp = "a".repeat(64);
    expect(compareRootTrustFingerprint(fp, fp).kind).toBe("none");
    expect(compareRootTrustFingerprint(fp, `${fp.slice(0, 62)}00`).kind).toBe(
      "changed",
    );
  });
});
