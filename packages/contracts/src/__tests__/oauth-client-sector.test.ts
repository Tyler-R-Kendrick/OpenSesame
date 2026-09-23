import { describe, expect, it } from "vitest";
import {
  CreateOAuthClientRequestSchema,
  PatchOAuthClientRequestSchema,
  ReleaseSectorClaimRequestSchema,
  redirectUrisOutsideSector,
} from "../index.js";

describe("redirect URIs and the sector they claim", () => {
  it("accepts the sector's host and its subdomains", () => {
    expect(
      redirectUrisOutsideSector("https://rp.example", [
        "https://rp.example/cb",
        "https://app.rp.example/cb",
        "https://RP.example:8443/cb",
        "https://a.b.rp.example/cb",
      ]),
    ).toEqual([]);
    // A path on the sector does not narrow the host it names.
    expect(
      redirectUrisOutsideSector("https://rp.example/tenant-a", [
        "https://rp.example/other/cb",
      ]),
    ).toEqual([]);
  });

  it("names every redirect the sector does not cover", () => {
    const outside = [
      "https://attacker.example/cb",
      "https://evilrp.example/cb",
      "https://rp.example.attacker.example/cb",
      "http://127.0.0.1:5173/cb",
      "http://localhost:3000/cb",
      "com.example.app:/cb",
    ];
    expect(
      redirectUrisOutsideSector("https://rp.example", [
        "https://rp.example/cb",
        ...outside,
      ]),
    ).toEqual(outside);
  });

  it("covers nothing when the sector is not a web URL", () => {
    expect(
      redirectUrisOutsideSector("sector_abc", ["https://rp.example/cb"]),
    ).toEqual(["https://rp.example/cb"]);
  });
});

describe("sector proof and release requests", () => {
  const base = {
    displayName: "RP",
    redirectUris: ["https://rp.example/cb"],
    sectorIdentifier: "https://rp.example",
  };

  it("takes a sector identifier document only as an https URL", () => {
    expect(
      CreateOAuthClientRequestSchema.safeParse({
        ...base,
        sectorIdentifierUri: "https://rp.example/sector.json",
      }).success,
    ).toBe(true);
    for (const sectorIdentifierUri of [
      "http://rp.example/sector.json",
      "https://rp.example/sector.json?x=1",
      "https://user@rp.example/sector.json",
      "file:///etc/passwd",
    ]) {
      expect(
        CreateOAuthClientRequestSchema.safeParse({
          ...base,
          sectorIdentifierUri,
        }).success,
        sectorIdentifierUri,
      ).toBe(false);
    }
    expect(
      PatchOAuthClientRequestSchema.safeParse({
        sectorIdentifierUri: "https://rp.example/sector.json",
      }).success,
    ).toBe(true);
  });

  it("requires a sector and a reason to release one", () => {
    expect(
      ReleaseSectorClaimRequestSchema.safeParse({
        sectorIdentifier: "https://victim.example",
        reason: "squatted; ownership verified out of band",
      }).success,
    ).toBe(true);
    expect(
      ReleaseSectorClaimRequestSchema.safeParse({
        sectorIdentifier: "https://victim.example",
        reason: "hand to the verified owner",
        nextOwnerPrincipalId: "prn_owner",
      }).success,
    ).toBe(true);
    for (const body of [
      { sectorIdentifier: "https://victim.example" },
      { sectorIdentifier: "", reason: "x" },
      { sectorIdentifier: "https://victim.example", reason: "  " },
      { sectorIdentifier: "https://victim.example", reason: "x", extra: 1 },
      {
        sectorIdentifier: "https://victim.example",
        reason: "x",
        nextOwnerPrincipalId: " ",
      },
    ]) {
      expect(ReleaseSectorClaimRequestSchema.safeParse(body).success).toBe(
        false,
      );
    }
  });
});
