import { describe, expect, it } from "vitest";
import {
  type SecurityProfile,
  mayPairLocalAuthority,
  resolveDeploymentProfile,
} from "./deployment-profile.js";

describe("deployment authority", () => {
  const profile: SecurityProfile = {
    version: 1,
    profile: "dedicated_origin",
    canonicalOrigin: "https://vault.example",
    headerSecurity: true,
  };
  it("requires exact configured origin and header-delivering dedicated deployment", () => {
    expect(mayPairLocalAuthority("https://vault.example", profile)).toBe(true);
    expect(mayPairLocalAuthority("https://attacker.example", profile)).toBe(
      false,
    );
    expect(
      mayPairLocalAuthority("https://vault.example", {
        ...profile,
        headerSecurity: false,
      }),
    ).toBe(false);
  });
  it("never elevates the path-hosted demo through endpoint configuration", () => {
    expect(
      mayPairLocalAuthority("https://tyler-r-kendrick.github.io", {
        ...profile,
        canonicalOrigin: "https://tyler-r-kendrick.github.io",
      }),
    ).toBe(false);
    expect(
      resolveDeploymentProfile("https://tyler-r-kendrick.github.io", {
        ...profile,
        canonicalOrigin: "https://tyler-r-kendrick.github.io",
        profile: "shared_origin_demo",
      }),
    ).toBe("shared_origin_demo");
  });
  it("limits development pairing to actual loopback", () => {
    expect(
      mayPairLocalAuthority("http://localhost:5180", {
        ...profile,
        canonicalOrigin: "http://localhost:5180",
        profile: "loopback_development",
        headerSecurity: false,
      }),
    ).toBe(true);
    expect(
      mayPairLocalAuthority("https://remote.example", {
        ...profile,
        canonicalOrigin: "https://remote.example",
        profile: "loopback_development",
      }),
    ).toBe(false);
  });
});
