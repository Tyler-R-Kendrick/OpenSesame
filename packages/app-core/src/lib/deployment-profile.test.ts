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
      mayPairLocalAuthority("https://opensesame-labs.github.io", {
        ...profile,
        canonicalOrigin: "https://opensesame-labs.github.io",
      }),
    ).toBe(false);
    expect(
      resolveDeploymentProfile("https://opensesame-labs.github.io", {
        ...profile,
        canonicalOrigin: "https://opensesame-labs.github.io",
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
  it("accepts an isolated-app profile only inside an IWA origin", () => {
    const profile = {
      version: 1 as const,
      profile: "isolated_web_app" as const,
      canonicalOrigin: "isolated-app:",
      headerSecurity: true,
    };
    expect(resolveDeploymentProfile("isolated-app://abc123/", profile)).toBe(
      "isolated_web_app",
    );
    expect(resolveDeploymentProfile("https://example.test/", profile)).toBe(
      "shared_origin_demo",
    );
  });
});
