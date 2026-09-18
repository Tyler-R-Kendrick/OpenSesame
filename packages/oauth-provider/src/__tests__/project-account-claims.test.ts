import { describe, expect, it } from "vitest";
import {
  RESERVED_PROTOCOL_CLAIMS,
  ReservedClaimError,
  previewAccountClaims,
  projectAccountClaims,
} from "../claims/project-account-claims.js";

const SUB = "pairwise-sub-1";
const PRINCIPAL = {
  name: "Ada Lovelace",
  email: "ada@example.test",
  emailVerified: true,
  emailAuthoritative: true,
  roles: ["admin"],
  groups: ["eng"],
  orgId: "org-home",
};

describe("projectAccountClaims", () => {
  it("emits only pairwise sub by default", () => {
    expect(projectAccountClaims({ pairwiseSub: SUB })).toEqual({ sub: SUB });
  });

  it("releases name and authoritative email when scopes and mapping allow", () => {
    expect(
      projectAccountClaims({
        pairwiseSub: SUB,
        scope: "openid profile email",
        principal: PRINCIPAL,
        mapping: { allow: ["name", "email", "email_verified"] },
      }),
    ).toEqual({
      sub: SUB,
      name: "Ada Lovelace",
      email: "ada@example.test",
      email_verified: true,
    });
  });

  it("omits untrusted email even when the email scope is granted", () => {
    expect(
      projectAccountClaims({
        pairwiseSub: SUB,
        scope: "openid email",
        principal: {
          email: "ada@untrusted.test",
          emailVerified: true,
          emailAuthoritative: false,
        },
        mapping: { allow: ["email", "email_verified"] },
      }),
    ).toEqual({ sub: SUB });
  });

  it("omits unverified email", () => {
    expect(
      projectAccountClaims({
        pairwiseSub: SUB,
        scope: "openid email",
        principal: {
          email: "ada@example.test",
          emailVerified: false,
        },
      }),
    ).toEqual({ sub: SUB });
  });

  it("omits unrelated org groups and roles", () => {
    expect(
      projectAccountClaims({
        pairwiseSub: SUB,
        scope: "openid profile",
        principal: PRINCIPAL,
        mapping: {
          allow: ["name", "roles", "groups"],
          orgId: "org-other",
        },
      }),
    ).toEqual({ sub: SUB, name: "Ada Lovelace" });
  });

  it("releases directory claims only for the mapped org", () => {
    expect(
      projectAccountClaims({
        pairwiseSub: SUB,
        scope: "openid",
        principal: PRINCIPAL,
        mapping: {
          allow: ["roles", "groups"],
          orgId: "org-home",
        },
      }),
    ).toEqual({
      sub: SUB,
      roles: ["admin"],
      groups: ["eng"],
    });
  });

  it("ADV-16: mapping cannot replace reserved sub or aud", () => {
    expect(() =>
      projectAccountClaims({
        pairwiseSub: SUB,
        mapping: { claims: { sub: "attacker" } },
      }),
    ).toThrow(ReservedClaimError);
    expect(() =>
      projectAccountClaims({
        pairwiseSub: SUB,
        mapping: { claims: { aud: "https://evil.test" } },
      }),
    ).toThrow(ReservedClaimError);
  });

  it("ADV-16: other reserved protocol claims are fenced, not copied", () => {
    const claims = projectAccountClaims({
      pairwiseSub: SUB,
      mapping: {
        claims: { iss: "https://evil.test", exp: 1, nickname: "ada" },
      },
    });
    expect(claims).toEqual({ sub: SUB, nickname: "ada" });
    for (const name of RESERVED_PROTOCOL_CLAIMS) {
      if (name === "sub") continue;
      expect(claims).not.toHaveProperty(name);
    }
  });

  it("preview is the same unsigned projector", () => {
    const input = {
      pairwiseSub: SUB,
      scope: "openid profile",
      principal: PRINCIPAL,
      mapping: { allow: ["name"] },
    };
    expect(previewAccountClaims(input)).toEqual(projectAccountClaims(input));
    expect(previewAccountClaims(input)).toEqual({
      sub: SUB,
      name: "Ada Lovelace",
    });
  });
});
