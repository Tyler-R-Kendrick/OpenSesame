import { describe, expect, it } from "vitest";
import { LIMITATIONS, OFFLINE_ENVELOPE, offlineAllowance, policyValidity } from "./expiry.js";
import { classifyPolicySource, provenanceCopy, provenanceMayGovern } from "./provenance.js";

const WINDOW = { notBefore: "2026-09-01T00:00:00.000Z", expires: "2026-10-01T00:00:00.000Z" };

describe("policy validity and the offline envelope (S03, TRUST-09/10)", () => {
  it("judges the window by the supplied clock only", () => {
    expect(policyValidity(WINDOW, "2026-09-15T00:00:00.000Z")).toBe("valid");
    expect(policyValidity(WINDOW, "2026-08-31T23:59:59.000Z")).toBe("not-yet-valid");
    expect(policyValidity(WINDOW, "2026-10-01T00:00:00.000Z")).toBe("expired");
    expect(policyValidity({}, "2026-09-15T00:00:00.000Z")).toBe("valid");
    expect(policyValidity(WINDOW, "soon")).toBe("malformed-time");
    expect(policyValidity({ expires: "never" }, "2026-09-15T00:00:00.000Z")).toBe("malformed-time");
  });

  it("an expired policy keeps running and keeps governing but accepts nothing new", () => {
    expect(offlineAllowance("valid")).toEqual({ keepRunning: true, acceptNew: true, remainsCeiling: true });
    expect(offlineAllowance("expired")).toEqual({ keepRunning: true, acceptNew: false, remainsCeiling: true });
    expect(offlineAllowance("not-yet-valid").acceptNew).toBe(false);
    for (const allowance of Object.values(OFFLINE_ENVELOPE)) {
      // No validity state ever drops the ceiling back to personal-local.
      expect(allowance.remainsCeiling).toBe(true);
    }
  });

  it("states its limitations in product copy", () => {
    expect(LIMITATIONS.length).toBeGreaterThanOrEqual(3);
    expect(LIMITATIONS.join(" ")).toMatch(/storage/i);
    expect(LIMITATIONS.join(" ")).toMatch(/clock/i);
  });
});

describe("provenance (S03)", () => {
  it("classifies sources without inferring from content", () => {
    expect(classifyPolicySource({ kind: "none" })).toBe("personal-local");
    expect(classifyPolicySource({ kind: "runtime-config" })).toBe("same-origin-deployment");
    expect(classifyPolicySource({ kind: "signed-import", verified: true })).toBe("signed-import");
    expect(classifyPolicySource({ kind: "signed-import", verified: false })).toBe("invitation-unverified");
    expect(
      classifyPolicySource({ kind: "invitation", verified: true, fingerprintConfirmed: false }),
    ).toBe("invitation-unverified");
    expect(
      classifyPolicySource({ kind: "invitation", verified: false, fingerprintConfirmed: true }),
    ).toBe("invitation-unverified");
    expect(
      classifyPolicySource({ kind: "invitation", verified: true, fingerprintConfirmed: true }),
    ).toBe("signed-import");
  });

  it("labels a same-origin deployment honestly and never calls it verified", () => {
    const deployment = provenanceCopy("same-origin-deployment");
    expect(deployment.trust).toBe("deployment");
    expect(deployment.claim).not.toMatch(/verified/i);
    expect(provenanceCopy("signed-import").trust).toBe("verified");
    expect(provenanceCopy("invitation-unverified").claim).toMatch(/fingerprint/i);
    expect(provenanceMayGovern("invitation-unverified")).toBe(false);
    expect(provenanceMayGovern("same-origin-deployment")).toBe(true);
  });
});
