import { describe, expect, it } from "vitest";
import { AUDIT_VALUE_MAX_LENGTH, redactAuditMetadata } from "../redact.js";

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

  it("keeps the fields that say which identity was linked", () => {
    // The link event carries the assurance upgrade, so an audit trail that drops
    // the issuer and kind on the way in is missing exactly what a reviewer reads.
    expect(
      redactAuditMetadata({
        action: "principal.link_identity",
        kind: "oidc",
        issuer: "https://idp.example",
        tenant: "acme",
        note: "email_not_used_for_link",
      }),
    ).toEqual({
      action: "principal.link_identity",
      kind: "oidc",
      issuer: "https://idp.example",
      tenant: "acme",
      note: "email_not_used_for_link",
    });
  });

  it("bounds a caller-supplied value", () => {
    const long = "https://idp.example/".padEnd(5_000, "x");
    const out = redactAuditMetadata({ issuer: long }) as { issuer: string };
    // Truncated, not dropped: a shortened issuer still says what happened, and
    // the store no longer grows to whatever length a caller sends.
    expect(out.issuer.length).toBe(AUDIT_VALUE_MAX_LENGTH + 1);
    expect(out.issuer.startsWith("https://idp.example/")).toBe(true);
    expect(out.issuer.endsWith("…")).toBe(true);
  });
});
