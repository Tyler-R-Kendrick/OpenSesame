import { isFunction } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  type MagicLinkDelivery,
  createUpstreamAuth,
} from "../better-auth.js";
import { noEmailAutoLinkPolicy } from "../email-link.js";
import { MemoryPrincipalMappingStore } from "../mapping.js";
import {
  UpstreamOidcProviderRegistry,
  mockUpstreamProvider,
} from "../oidc-registry.js";
import { createPasskeySeam } from "../passkey.js";

function baseOptions(sent: MagicLinkDelivery[] = []) {
  return {
    baseURL: "http://127.0.0.1:8788",
    basePath: "/v1/auth",
    secret: "test-secret-test-secret-test-secret-32",
    trustedOrigins: [],
    magicLink: {
      sendMagicLink: async (delivery: MagicLinkDelivery) => {
        sent.push(delivery);
      },
    },
  };
}

describe("createUpstreamAuth", () => {
  it("builds a Better Auth instance with email/password disabled", () => {
    const bundle = createUpstreamAuth({
      ...baseOptions(),
      mappingStore: new MemoryPrincipalMappingStore(),
    });

    expect(bundle.auth).toBeDefined();
    expect(isFunction(bundle.auth.handler)).toBe(true);
    expect(bundle.auth.options.emailAndPassword?.enabled).toBe(false);
    // Account linking is disabled: principals are mapped, never auto-linked.
    expect(bundle.auth.options.account?.accountLinking?.enabled).toBe(false);
    expect(bundle.auth.options.basePath).toBe("/v1/auth");
  });

  it("enables the magic-link method and nothing else", () => {
    const bundle = createUpstreamAuth({
      ...baseOptions(),
      mappingStore: new MemoryPrincipalMappingStore(),
    });

    expect(bundle.signInMethods).toEqual(["magic-link"]);
    expect(isFunction(bundle.auth.api.signInMagicLink)).toBe(true);
    expect(isFunction(bundle.auth.api.magicLinkVerify)).toBe(true);
  });

  it("threads the mapping store, policy, and optional seams through the bundle", () => {
    const mappingStore = new MemoryPrincipalMappingStore();
    const providerRegistry = new UpstreamOidcProviderRegistry();
    providerRegistry.register(mockUpstreamProvider({ id: "github" }));
    const passkeySeam = createPasskeySeam();

    const bundle = createUpstreamAuth({
      ...baseOptions(),
      mappingStore,
      providerRegistry,
      passkeySeam,
    });

    expect(bundle.mappingStore).toBe(mappingStore);
    expect(bundle.providerRegistry).toBe(providerRegistry);
    expect(bundle.passkeySeam).toBe(passkeySeam);
    expect(bundle.emailLinkPolicy).toBe(noEmailAutoLinkPolicy);
  });

  it("keeps the social catalog empty even when a registry is supplied (T22)", () => {
    // `toBetterAuthSocialConfig` drops every provider without a clientSecret,
    // so a registry of origin-profile brokers would configure nothing while
    // looking configured. The registry owns social; this mount does not.
    const providerRegistry = new UpstreamOidcProviderRegistry();
    providerRegistry.register(mockUpstreamProvider({ id: "github" }));

    const bundle = createUpstreamAuth({
      ...baseOptions(),
      mappingStore: new MemoryPrincipalMappingStore(),
      providerRegistry,
    });

    expect(bundle.auth.options.socialProviders ?? {}).toEqual({});
  });

  it("works without a provider registry or passkey seam", () => {
    const bundle = createUpstreamAuth({
      ...baseOptions(),
      mappingStore: new MemoryPrincipalMappingStore(),
    });

    expect(bundle.providerRegistry).toBeUndefined();
    expect(bundle.passkeySeam).toBeUndefined();
    expect(bundle.auth.options.socialProviders ?? {}).toEqual({});
  });

  it("delivers a magic link through the configured transport, single-use", async () => {
    const sent: MagicLinkDelivery[] = [];
    const bundle = createUpstreamAuth({
      ...baseOptions(sent),
      mappingStore: new MemoryPrincipalMappingStore(),
    });

    await bundle.auth.api.signInMagicLink({
      body: { email: "person@example.test", metadata: { interactionUid: "u1" } },
      headers: new Headers(),
    });

    const delivery = sent[0];
    expect(sent).toHaveLength(1);
    expect(delivery?.email).toBe("person@example.test");
    expect(delivery?.token).toBeTruthy();
    expect(delivery?.metadata).toEqual({ interactionUid: "u1" });

    const token = delivery?.token ?? "";
    const verified = await bundle.auth.api.magicLinkVerify({
      query: { token },
      headers: new Headers(),
    });
    expect(verified.user.email).toBe("person@example.test");
    expect(verified.user.emailVerified).toBe(true);

    // Consumed atomically on the first verification (Better Auth 1.6.26).
    await expect(
      bundle.auth.api.magicLinkVerify({
        query: { token },
        headers: new Headers(),
      }),
    ).rejects.toBeTruthy();
  });
});
