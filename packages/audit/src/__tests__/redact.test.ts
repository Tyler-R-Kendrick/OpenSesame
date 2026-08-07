import { describe, expect, it } from "vitest";
import { redactAuditMetadata } from "../redact.js";

describe("redactAuditMetadata", () => {
  it("keeps allowlisted keys and drops secrets", () => {
    const out = redactAuditMetadata({
      action: "claim.complete",
      claimToken: "osc_clm_x.y",
      userCode: "AAAA-BBBB",
      password: "nope",
      unknownField: "drop-me",
      state: "completed",
    });
    expect(out).toEqual({
      action: "claim.complete",
      state: "completed",
    });
  });
});
