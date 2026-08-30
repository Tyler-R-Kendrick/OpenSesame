import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANIFEST_DIR_ENV,
  loadManifestProviders,
} from "../interactions/manifest-providers.js";
import {
  ProviderConfigError,
  loadProviderRegistry,
} from "../interactions/registry.js";

const dirs: string[] = [];

function manifestDir(files: ReadonlyArray<readonly [string, string]>): string {
  const dir = mkdtempSync(join(tmpdir(), "os-provider-manifests-"));
  dirs.push(dir);
  for (const [name, body] of files) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const OIDC_MANIFEST = {
  id: "communityidp",
  kind: "oidc",
  label: "Community IdP",
  issuer: "https://idp.community.example",
  scopes: "openid email",
  clientAuth: "client_secret_post",
  clientId: "os-client",
  clientSecretEnv: "COMMUNITY_IDP_SECRET",
};

describe("manifest provider descriptors (ADR 0065 §6)", () => {
  it("returns nothing when the directory variable is unset", () => {
    expect(loadManifestProviders({})).toEqual([]);
  });

  it("loads a valid descriptor and resolves its secret from the environment", () => {
    const dir = manifestDir([
      ["community.provider.json", JSON.stringify(OIDC_MANIFEST)],
    ]);
    const providers = loadManifestProviders({
      [MANIFEST_DIR_ENV]: dir,
      COMMUNITY_IDP_SECRET: "s3cret-value",
    });
    expect(providers).toHaveLength(1);
    const provider = providers[0];
    expect(provider?.id).toBe("communityidp");
    expect(provider?.issuer).toBe("https://idp.community.example");
    // The secret is resolved, not copied from the file.
    expect(provider?.kind === "oidc" && provider.clientSecret).toBe(
      "s3cret-value",
    );
  });

  it("refuses an inline clientSecret — files carry references, never values", () => {
    const dir = manifestDir([
      [
        "leaky.provider.json",
        JSON.stringify({
          ...OIDC_MANIFEST,
          clientSecretEnv: undefined,
          clientSecret: "oops-a-secret",
        }),
      ],
    ]);
    expect(() => loadManifestProviders({ [MANIFEST_DIR_ENV]: dir })).toThrow(
      /may not carry `clientSecret`/,
    );
  });

  it("refuses Apple signing material — not manifestable", () => {
    const dir = manifestDir([
      [
        "apple.provider.json",
        JSON.stringify({
          ...OIDC_MANIFEST,
          clientSecretEnv: undefined,
          apple: { teamId: "T", keyId: "K", privateKeyPem: "PEM" },
        }),
      ],
    ]);
    expect(() => loadManifestProviders({ [MANIFEST_DIR_ENV]: dir })).toThrow(
      /may not carry `apple`/,
    );
  });

  it("refuses when the referenced secret variable is unset", () => {
    const dir = manifestDir([
      ["community.provider.json", JSON.stringify(OIDC_MANIFEST)],
    ]);
    expect(() => loadManifestProviders({ [MANIFEST_DIR_ENV]: dir })).toThrow(
      /COMMUNITY_IDP_SECRET, which is unset/,
    );
  });

  it("refuses unknown keys instead of ignoring them", () => {
    const dir = manifestDir([
      [
        "extra.provider.json",
        JSON.stringify({
          ...OIDC_MANIFEST,
          clientSecretEnv: undefined,
          clientAuth: "none",
          clientId: undefined,
          surprise: true,
        }),
      ],
    ]);
    expect(() => loadManifestProviders({ [MANIFEST_DIR_ENV]: dir })).toThrow(
      /unknown key `surprise`/,
    );
  });

  it("refuses malformed JSON and unreadable directories loudly", () => {
    const dir = manifestDir([["broken.provider.json", "{not json"]]);
    expect(() => loadManifestProviders({ [MANIFEST_DIR_ENV]: dir })).toThrow(
      ProviderConfigError,
    );
    expect(() =>
      loadManifestProviders({ [MANIFEST_DIR_ENV]: "/does/not/exist" }),
    ).toThrow(/not readable/);
  });

  it("joins the static registry and cannot shadow configured providers", () => {
    const dir = manifestDir([
      ["community.provider.json", JSON.stringify(OIDC_MANIFEST)],
    ]);
    const env = {
      [MANIFEST_DIR_ENV]: dir,
      COMMUNITY_IDP_SECRET: "s3cret-value",
    };
    const registry = loadProviderRegistry(env);
    expect(registry.map((provider) => provider.id)).toContain("communityidp");

    // Same issuer already configured via the environment → refuse the boot.
    const shadowEnv = {
      ...env,
      OPENSESAME_PROVIDERS: "shadow",
      OPENSESAME_PROVIDER_SHADOW_KIND: "oidc",
      OPENSESAME_PROVIDER_SHADOW_LABEL: "Shadow",
      OPENSESAME_PROVIDER_SHADOW_ISSUER: "https://idp.community.example",
      OPENSESAME_PROVIDER_SHADOW_SCOPES: "openid",
      OPENSESAME_PROVIDER_SHADOW_CLIENT_AUTH: "none",
    };
    expect(() => loadProviderRegistry(shadowEnv)).toThrow(
      /reuses issuer|same issuer/,
    );
  });

  it("non-manifest files in the directory are ignored", () => {
    const dir = manifestDir([
      ["README.md", "docs, not a descriptor"],
      ["community.provider.json", JSON.stringify(OIDC_MANIFEST)],
    ]);
    const providers = loadManifestProviders({
      [MANIFEST_DIR_ENV]: dir,
      COMMUNITY_IDP_SECRET: "s3cret-value",
    });
    expect(providers).toHaveLength(1);
  });
});
