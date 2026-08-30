import { describe, expect, it } from "vitest";
import {
  ClaimSessionResponseSchema,
  PresentClaimRequestSchema,
  PresentClaimResponseSchema,
} from "../claims.js";

const session = {
  id: "clm_1",
  type: "resource_bundle",
  state: "presented",
  targetManifestDigest: "digest",
  expiresAt: new Date().toISOString(),
  version: 2,
  items: [],
};

describe("claims contracts", () => {
  it("present accepts the original token-only shape", () => {
    const parsed = PresentClaimRequestSchema.parse({
      token: "osc_clm_clm_1.secretpart",
    });
    expect(parsed.userCode).toBeUndefined();
  });

  it("present accepts an optional user code within the consent-code bounds", () => {
    const parsed = PresentClaimRequestSchema.parse({
      token: "osc_clm_clm_1.secretpart",
      userCode: "ABCD-EFGH",
    });
    expect(parsed.userCode).toBe("ABCD-EFGH");
  });

  it("present refuses codes outside the consent-code bounds", () => {
    // The bounds mirror CompleteClaimRequestSchema.userCode, so a code the
    // fence would read is never rejected by shape before it reaches it.
    for (const userCode of ["abc", "x".repeat(65)]) {
      expect(
        PresentClaimRequestSchema.safeParse({
          token: "osc_clm_clm_1.secretpart",
          userCode,
        }).success,
      ).toBe(false);
    }
  });

  it("the present response carries the manifest; every other projection drops it", () => {
    const manifest = { kind: "secret-drop", ciphertext: "Y2lwaGVy" };
    const presented = PresentClaimResponseSchema.parse({
      ...session,
      targetManifest: manifest,
    });
    expect(presented.targetManifest).toEqual(manifest);

    // Zod strips unknown keys: GET/poll/complete keep seeing only the digest
    // even if a future projection passes the manifest through by mistake.
    const projected = ClaimSessionResponseSchema.parse({
      ...session,
      targetManifest: manifest,
    });
    expect("targetManifest" in projected).toBe(false);
  });
});
