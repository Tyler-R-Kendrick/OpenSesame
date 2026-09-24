import { describe, expect, it } from "vitest";
import {
  BUNDLED_REVISION,
  bundledProviders,
  decodeEmbeddedProviders,
  getBundledProviders,
} from "./embedded-catalog.js";

describe("embedded connector catalog", () => {
  it("contains every Fnox, LLM, and identity provider once", () => {
    const ids = bundledProviders.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(53);
    for (const id of [
      "webcrypto",
      "azure-key-vault-secrets",
      "bitwarden",
      "github",
      "gitlab",
      "bitbucket",
      "codeberg",
      "origin",
      "vercel",
      "linear",
      "tailscale",
      "cloudflare-wallet",
      "google-wallet",
      "apple-wallet",
      "samsung-wallet",
      "privacy",
      "lithic",
      "marqeta",
      "stripe-issuing",
      "anthropic",
      "openai",
      "azure-openai",
      "aws-bedrock",
      "openrouter",
      "huggingface",
      "better-auth",
      "workos",
      "auth0",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("prepends forge-agnostic git under backup/recovery", () => {
    const providers = getBundledProviders();
    expect(providers[0]).toMatchObject({
      id: "git",
      category: "backup_recovery",
      authKind: "configuration",
    });
    expect(providers.some((provider) => provider.id === "gitlab")).toBe(true);
    expect(providers.some((provider) => provider.id === "bitbucket")).toBe(
      true,
    );
    expect(providers.some((provider) => provider.id === "codeberg")).toBe(true);
    expect(providers.some((provider) => provider.id === "origin")).toBe(true);
  });

  it("keeps identity fallback authority aligned with the Host catalog", () => {
    const betterAuth = bundledProviders.find(
      (provider) => provider.id === "better-auth",
    );
    const workos = bundledProviders.find(
      (provider) => provider.id === "workos",
    );
    const auth0 = bundledProviders.find((provider) => provider.id === "auth0");
    expect(betterAuth?.operations).toEqual(["identity.configure"]);
    expect(auth0?.operations).toEqual(["identity.configure"]);
    expect(workos?.operations).toEqual([
      "user.read",
      "organization.read",
      "directory.read",
    ]);
    expect(
      bundledProviders.find((provider) => provider.id === "github")
        ?.displayName,
    ).toBe("GitHub");
    expect(
      bundledProviders.find((provider) => provider.id === "github")?.operations,
    ).toEqual(
      expect.arrayContaining(["repository.read", "contents.write", "git.push"]),
    );
    expect(
      bundledProviders.find((provider) => provider.id === "webcrypto")
        ?.category,
    ).toBe("encryption");
    expect(workos?.egress).toEqual({
      scheme: "https",
      authorities: ["api.workos.com"],
      pathPrefixes: [],
    });
  });

  it("rejects a valid catalog cached before the bundled revision existed", () => {
    expect(
      decodeEmbeddedProviders(JSON.stringify(bundledProviders)),
    ).toBeNull();
    expect(
      decodeEmbeddedProviders(
        JSON.stringify({
          revision: "2026-09-21.2",
          providers: bundledProviders,
        }),
      ),
    ).toBeNull();
    expect(
      decodeEmbeddedProviders(
        JSON.stringify({
          revision: BUNDLED_REVISION,
          providers: bundledProviders,
        }),
      ),
    ).toEqual(bundledProviders);
  });

  it("ships a non-empty marketplace catalog (not only auto-configurables)", () => {
    const marketplace = bundledProviders.filter(
      (provider) => !provider.autoConfigurable,
    );
    expect(marketplace.length).toBeGreaterThan(20);
  });
});

describe("fido2 is not a catalog connector", () => {
  it("omits fido2 from bundledProviders", () => {
    expect(bundledProviders.some((provider) => provider.id === "fido2")).toBe(
      false,
    );
  });
});
