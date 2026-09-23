import { describe, expect, it } from "vitest";
import {
  mappingOverridesReserved,
  previewSyntheticClaims,
} from "./claim-preview.js";

describe("claim preview", () => {
  it("matches issuance defaults: sub only unless scopes and authority allow more", () => {
    const minimal = previewSyntheticClaims({
      pairwiseSub: "pair-1",
      scopes: ["openid"],
      persona: { name: "Ada", email: "ada@x.test" },
    });
    expect(minimal).toEqual({
      sub: "pair-1",
      omitted: ["name", "email", "groups"],
    });
    const full = previewSyntheticClaims({
      pairwiseSub: "pair-1",
      scopes: ["openid", "profile", "email"],
      persona: {
        name: "Ada",
        email: "ada@x.test",
        emailVerified: true,
        emailAuthoritative: true,
        orgId: "org-a",
        groups: ["ops"],
      },
      mappingOrgId: "org-a",
    });
    expect(full.name).toBe("Ada");
    expect(full.email_verified).toBe(true);
    expect(full.groups).toEqual(["ops"]);
  });

  it("does not treat reserved mapping as allowed", () => {
    expect(mappingOverridesReserved({ sub: "spoof" })).toBe(true);
    expect(mappingOverridesReserved({ name: "Ada" })).toBe(false);
  });
});
