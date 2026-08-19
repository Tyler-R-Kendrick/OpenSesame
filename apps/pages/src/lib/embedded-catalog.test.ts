import { describe, expect, it } from "vitest";
import {
  bundledProviders,
  decodeEmbeddedProviders,
} from "./embedded-catalog.js";

describe("embedded connector catalog", () => {
  it("contains every Fnox, LLM, and identity provider once", () => {
    const ids = bundledProviders.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(43);
    for (const id of [
      "webcrypto",
      "azure-key-vault-secrets",
      "bitwarden",
      "github",
      "gitlab",
      "vercel",
      "linear",
      "stripe",
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
          revision: "2026-08-13.1",
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
