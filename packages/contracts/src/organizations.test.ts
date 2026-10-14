import { describe, expect, it } from "vitest";
import { UpdateOrganizationRequestSchema } from "./organizations.js";

describe("native SAML configuration", () => {
  it.each(["urn:example:idp:acme", "https://idp.example/entity"])(
    "accepts the %s entity identifier",
    (samlIssuer) => {
      expect(
        UpdateOrganizationRequestSchema.safeParse({
          samlIssuer,
          samlMetadataUrl: "https://idp.example/metadata",
        }).success,
      ).toBe(true);
    },
  );
  it.each([
    "urn:example:bad name",
    "javascript:alert(1)",
    "https://user:password@idp.example",
    "urn:example:\nentity",
  ])("refuses the malformed entity identifier %s", (samlIssuer) => {
    expect(
      UpdateOrganizationRequestSchema.safeParse({
        samlIssuer,
        samlMetadataUrl: "https://idp.example/metadata",
      }).success,
    ).toBe(false);
  });
  it("keeps metadata addresses limited to network URLs", () => {
    expect(
      UpdateOrganizationRequestSchema.safeParse({
        samlIssuer: "urn:example:idp",
        samlMetadataUrl: "urn:example:metadata",
      }).success,
    ).toBe(false);
  });
});
