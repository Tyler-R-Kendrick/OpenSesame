import { describe, expect, it } from "vitest";
import { createUpstreamAuth } from "../better-auth.js";
import { noEmailAutoLinkPolicy } from "../email-link.js";
import { MemoryPrincipalMappingStore } from "../mapping.js";
import {
  UpstreamOidcProviderRegistry,
  mockUpstreamProvider,
} from "../oidc-registry.js";
import { createPasskeySeam } from "../passkey.js";
import { isFunction } from "@opensesame/os-domain";

const baseOptions = {
  baseURL: "http://127.0.0.1:8788",
  secret: "test-secret-test-secret-test-secret-32",
};

describe("createUpstreamAuth", () => {
  it("builds a Better Auth instance with email/password disabled", () => {
    const bundle = createUpstreamAuth({
      ...baseOptions,
      mappingStore: new MemoryPrincipalMappingStore(),
    });

    expect(bundle.auth).toBeDefined();
    expect(isFunction(bundle.auth.handler)).toBe(true);
    expect(bundle.auth.options.emailAndPassword?.enabled).toBe(false);
    // Account linking is disabled: principals are mapped, never auto-linked.
    expect(bundle.auth.options.account?.accountLinking?.enabled).toBe(false);
  });

  it("threads the mapping store, policy, and optional seams through the bundle", () => {
    const mappingStore = new MemoryPrincipalMappingStore();
    const providerRegistry = new UpstreamOidcProviderRegistry();
    // Better Auth's socialProviders map is keyed by its built-in provider
    // ids, so the registry entry must use one of those here.
    providerRegistry.register(mockUpstreamProvider({ id: "github" }));
    const passkeySeam = createPasskeySeam();

    const bundle = createUpstreamAuth({
      ...baseOptions,
      mappingStore,
      providerRegistry,
      passkeySeam,
    });

    expect(bundle.mappingStore).toBe(mappingStore);
    expect(bundle.providerRegistry).toBe(providerRegistry);
    expect(bundle.passkeySeam).toBe(passkeySeam);
    expect(bundle.emailLinkPolicy).toBe(noEmailAutoLinkPolicy);
    // Registered provider reached the Better Auth socialProviders config.
    expect(bundle.auth.options.socialProviders?.github?.clientId).toBe(
      "opensesame-upstream",
    );
  });

  it("works without a provider registry or passkey seam", () => {
    const bundle = createUpstreamAuth({
      ...baseOptions,
      mappingStore: new MemoryPrincipalMappingStore(),
    });

    expect(bundle.providerRegistry).toBeUndefined();
    expect(bundle.passkeySeam).toBeUndefined();
    expect(bundle.auth.options.socialProviders ?? {}).toEqual({});
  });
});
