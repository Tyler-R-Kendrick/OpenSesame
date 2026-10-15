import { describe, expect, it } from "vitest";
import { compareRootTrustFingerprint } from "./trust-store.js";

describe("root trust fingerprint alarm", () => {
  const fp = "a".repeat(64);

  it("alarms when the fingerprint changes", () => {
    const next = "b".repeat(64);
    expect(compareRootTrustFingerprint(fp, next)).toEqual({
      kind: "changed",
      previous: fp,
      current: next,
    });
  });

  it("is silent when unchanged", () => {
    expect(compareRootTrustFingerprint(fp, fp)).toEqual({ kind: "none" });
  });
});
