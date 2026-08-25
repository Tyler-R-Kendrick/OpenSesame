import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Organization, overlapCast } from "@opensesame/os-domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ControlPlaneConfig,
  assertSecureConfig,
  loadConfig,
} from "../config.js";
import type { AppContext } from "../context.js";
import { createControlPlane } from "../create-app.js";
import {
  buildLoginPageModel,
  matchProviderHint,
} from "../interactions/handlers.js";
import {
  type ProviderDescriptor,
  isBrowserCapable,
  loadProviderRegistry,
  providerById,
  providerByIssuer,
  staticProviders,
} from "../interactions/registry.js";
import {
  type ByoUpstream,
  resolveTrustedIssuer,
} from "../interactions/trust.js";
import type { InteractionDetails } from "../interactions/types.js";

/**
 * The provider registry, the trust fence it feeds, and the public catalog.
 *
 * These are the units the rest of the federation work stands on: every leg
 * asks `resolveTrustedIssuer` whether an issuer may be federated to, and it
 * answers from what is parsed here. A parsing bug is therefore not a
 * configuration inconvenience — it is either a provider that cannot be used or
 * a client secret offered to the wrong party.
 */

const DEV = { OPENSESAME_ALLOW_DEV_DEFAULTS: "true" } as const;

function registry(env: NodeJS.ProcessEnv): ProviderDescriptor[] {
  return loadProviderRegistry(env);
}

/** The same environment minus one variable, for the all-or-none cases. */
function without(env: NodeJS.ProcessEnv, omitted: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key !== omitted),
  );
}

function appleEnv() {
  return {
    OPENSESAME_PROVIDERS: "apple",
    OPENSESAME_PROVIDER_APPLE_CLIENT_ID: "com.example.service",
    OPENSESAME_PROVIDER_APPLE_TEAM_ID: "TEAM123456",
    OPENSESAME_PROVIDER_APPLE_KEY_ID: "KEY1234567",
    OPENSESAME_PROVIDER_APPLE_PRIVATE_KEY: "pem",
  };
}

function gitlabEnv() {
  return {
    OPENSESAME_PROVIDERS: "gitlab",
    OPENSESAME_PROVIDER_GITLAB_KIND: "oauth2",
    OPENSESAME_PROVIDER_GITLAB_ISSUER: "https://gitlab.com",
    OPENSESAME_PROVIDER_GITLAB_AUTHORIZE_URL:
      "https://gitlab.com/oauth/authorize",
    OPENSESAME_PROVIDER_GITLAB_TOKEN_URL: "https://gitlab.com/oauth/token",
    OPENSESAME_PROVIDER_GITLAB_USERINFO_URL: "https://gitlab.com/api/v4/user",
    OPENSESAME_PROVIDER_GITLAB_SUBJECT_FIELD: "id",
    OPENSESAME_PROVIDER_GITLAB_CLIENT_ID: "gl-cid",
    OPENSESAME_PROVIDER_GITLAB_CLIENT_SECRET: "gl-secret",
  };
}

function oidc(descriptor: ProviderDescriptor | undefined) {
  if (descriptor?.kind !== "oidc") {
    throw new Error(`expected an oidc descriptor, got ${descriptor?.kind}`);
  }
  return descriptor;
}

function oauth2(descriptor: ProviderDescriptor | undefined) {
  if (descriptor?.kind !== "oauth2") {
    throw new Error(`expected an oauth2 descriptor, got ${descriptor?.kind}`);
  }
  return descriptor;
}

describe("built-in provider defaults", () => {
  it("configures Google from a client id and secret alone", () => {
    const [google] = registry({
      OPENSESAME_PROVIDERS: "google",
      OPENSESAME_PROVIDER_GOOGLE_CLIENT_ID: "google-cid",
      OPENSESAME_PROVIDER_GOOGLE_CLIENT_SECRET: "google-secret",
    });
    expect(oidc(google)).toEqual({
      id: "google",
      kind: "oidc",
      label: "Google",
      issuer: "https://accounts.google.com",
      scopes: "openid email profile",
      clientAuth: "client_secret_post",
      clientId: "google-cid",
      clientSecret: "google-secret",
    });
  });

  it("pins Microsoft to the configured tenant", () => {
    const [microsoft] = registry({
      OPENSESAME_PROVIDERS: "microsoft",
      OPENSESAME_PROVIDER_MICROSOFT_TENANT:
        "11111111-2222-3333-4444-555555555555",
      OPENSESAME_PROVIDER_MICROSOFT_CLIENT_ID: "ms-cid",
      OPENSESAME_PROVIDER_MICROSOFT_CLIENT_SECRET: "ms-secret",
    });
    expect(oidc(microsoft).issuer).toBe(
      "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0",
    );
  });

  /**
   * D4/T16. The multi-tenant endpoints publish the literal template
   * `https://login.microsoftonline.com/{tenantid}/v2.0` as their issuer, so an
   * exact-match issuer check can never pass. Refusing at config load is the
   * only honest answer; the alternative is relaxing issuer validation, which
   * is the one thing that must not happen.
   */
  it.each(["common", "organizations", "consumers"])(
    "refuses the multi-tenant Microsoft endpoint %s",
    (tenant) => {
      expect(() =>
        registry({
          OPENSESAME_PROVIDERS: "microsoft",
          OPENSESAME_PROVIDER_MICROSOFT_TENANT: tenant,
          OPENSESAME_PROVIDER_MICROSOFT_CLIENT_ID: "ms-cid",
          OPENSESAME_PROVIDER_MICROSOFT_CLIENT_SECRET: "ms-secret",
        }),
      ).toThrow(/multi-tenant/);
    },
  );

  it("refuses a hand-written templated Microsoft issuer too", () => {
    expect(() =>
      registry({
        OPENSESAME_PROVIDERS: "microsoft",
        OPENSESAME_PROVIDER_MICROSOFT_ISSUER:
          "https://login.microsoftonline.com/{tenantid}/v2.0",
        OPENSESAME_PROVIDER_MICROSOFT_CLIENT_ID: "ms-cid",
        OPENSESAME_PROVIDER_MICROSOFT_CLIENT_SECRET: "ms-secret",
      }),
    ).toThrow(/multi-tenant/);
  });

  it("requires a Microsoft tenant rather than guessing one", () => {
    expect(() =>
      registry({
        OPENSESAME_PROVIDERS: "microsoft",
        OPENSESAME_PROVIDER_MICROSOFT_CLIENT_ID: "ms-cid",
      }),
    ).toThrow(/TENANT is required/);
  });

  it("gives GitHub the OAuth2 leg with its real endpoints and a stable subject", () => {
    const [github] = registry({
      OPENSESAME_PROVIDERS: "github",
      OPENSESAME_PROVIDER_GITHUB_CLIENT_ID: "gh-cid",
      OPENSESAME_PROVIDER_GITHUB_CLIENT_SECRET: "gh-secret",
    });
    expect(oauth2(github)).toEqual({
      id: "github",
      kind: "oauth2",
      label: "GitHub",
      issuer: "https://github.com",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      userinfoEndpoint: "https://api.github.com/user",
      scopes: "read:user",
      // `id`, never `login`: a renameable subject is an account-takeover path.
      subjectField: "id",
      profileMap: { email: "email", name: "name" },
      clientId: "gh-cid",
      clientSecret: "gh-secret",
    });
  });

  it("configures Apple for form_post with an ES256 signing key", () => {
    const [apple] = registry({
      OPENSESAME_PROVIDERS: "apple",
      OPENSESAME_PROVIDER_APPLE_CLIENT_ID: "com.example.service",
      OPENSESAME_PROVIDER_APPLE_TEAM_ID: "TEAM123456",
      OPENSESAME_PROVIDER_APPLE_KEY_ID: "KEY1234567",
      OPENSESAME_PROVIDER_APPLE_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----",
    });
    const descriptor = oidc(apple);
    expect(descriptor.issuer).toBe("https://appleid.apple.com");
    expect(descriptor.clientAuth).toBe("apple_es256");
    expect(descriptor.responseMode).toBe("form_post");
    expect(descriptor.scopes).toBe("openid email name");
    expect(descriptor.apple).toEqual({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKeyPem:
        "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----",
    });
  });

  it("reads the Apple key from a file when no inline PEM is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "opensesame-apple-"));
    directories.push(dir);
    const path = join(dir, "apple.p8");
    writeFileSync(
      path,
      "-----BEGIN PRIVATE KEY-----\nfile\n-----END PRIVATE KEY-----\n",
    );
    const [apple] = registry({
      OPENSESAME_PROVIDERS: "apple",
      OPENSESAME_PROVIDER_APPLE_CLIENT_ID: "com.example.service",
      OPENSESAME_PROVIDER_APPLE_TEAM_ID: "TEAM123456",
      OPENSESAME_PROVIDER_APPLE_KEY_ID: "KEY1234567",
      OPENSESAME_PROVIDER_APPLE_PRIVATE_KEY_FILE: path,
    });
    expect(oidc(apple).apple?.privateKeyPem).toContain("file");
  });

  it("refuses a missing Apple key file rather than starting without a secret", () => {
    expect(() =>
      registry({
        OPENSESAME_PROVIDERS: "apple",
        OPENSESAME_PROVIDER_APPLE_CLIENT_ID: "com.example.service",
        OPENSESAME_PROVIDER_APPLE_TEAM_ID: "TEAM123456",
        OPENSESAME_PROVIDER_APPLE_KEY_ID: "KEY1234567",
        OPENSESAME_PROVIDER_APPLE_PRIVATE_KEY_FILE: "/nonexistent/apple.p8",
      }),
    ).toThrow(/PRIVATE_KEY_FILE could not be read/);
  });

  it.each([
    ["team id", "OPENSESAME_PROVIDER_APPLE_TEAM_ID"],
    ["key id", "OPENSESAME_PROVIDER_APPLE_KEY_ID"],
    ["private key", "OPENSESAME_PROVIDER_APPLE_PRIVATE_KEY"],
    ["client id", "OPENSESAME_PROVIDER_APPLE_CLIENT_ID"],
  ])("refuses an Apple provider missing its %s", (_label, omitted) => {
    expect(() => registry(without(appleEnv(), omitted))).toThrow(/required/);
  });
});

describe("generic providers", () => {
  it("configures an unknown id entirely from the environment", () => {
    const [keycloak] = registry({
      OPENSESAME_PROVIDERS: "keycloak",
      OPENSESAME_PROVIDER_KEYCLOAK_ISSUER:
        "https://kc.example.com/realms/main/",
      OPENSESAME_PROVIDER_KEYCLOAK_LABEL: "Acme SSO",
      OPENSESAME_PROVIDER_KEYCLOAK_CLIENT_ID: "kc-cid",
      OPENSESAME_PROVIDER_KEYCLOAK_SCOPES: "openid email",
    });
    expect(oidc(keycloak)).toEqual({
      id: "keycloak",
      kind: "oidc",
      label: "Acme SSO",
      // Trailing slash is not part of an issuer's identity.
      issuer: "https://kc.example.com/realms/main",
      scopes: "openid email",
      // No secret: this is the public origin-profile case, not an error.
      clientAuth: "none",
      clientId: "kc-cid",
    });
  });

  it("configures a generic oauth2 provider from its endpoints", () => {
    const [gitlab] = registry({
      ...gitlabEnv(),
      OPENSESAME_PROVIDER_GITLAB_SCOPES: "read_user",
    });
    expect(oauth2(gitlab).tokenEndpoint).toBe("https://gitlab.com/oauth/token");
    expect(oauth2(gitlab).subjectField).toBe("id");
    expect(oauth2(gitlab).scopes).toBe("read_user");
  });

  it.each([
    ["AUTHORIZE_URL", "OPENSESAME_PROVIDER_GITLAB_AUTHORIZE_URL"],
    ["SUBJECT_FIELD", "OPENSESAME_PROVIDER_GITLAB_SUBJECT_FIELD"],
    ["CLIENT_SECRET", "OPENSESAME_PROVIDER_GITLAB_CLIENT_SECRET"],
  ])("refuses a generic oauth2 provider with no %s", (_label, omitted) => {
    expect(() => registry(without(gitlabEnv(), omitted))).toThrow(/required/);
  });

  it("requires an issuer for an id it knows nothing about", () => {
    expect(() => registry({ OPENSESAME_PROVIDERS: "whoever" })).toThrow(
      /ISSUER is required/,
    );
  });

  it("refuses a client secret with no client id to authenticate as", () => {
    expect(() =>
      registry({
        OPENSESAME_PROVIDERS: "keycloak",
        OPENSESAME_PROVIDER_KEYCLOAK_ISSUER: "https://kc.example.com",
        OPENSESAME_PROVIDER_KEYCLOAK_CLIENT_SECRET: "orphan-secret",
      }),
    ).toThrow(/needs OPENSESAME_PROVIDER_KEYCLOAK_CLIENT_ID/);
  });

  it("refuses two providers claiming the same issuer", () => {
    expect(() =>
      registry({
        OPENSESAME_PROVIDERS: "one,two",
        OPENSESAME_PROVIDER_ONE_ISSUER: "https://idp.example",
        OPENSESAME_PROVIDER_TWO_ISSUER: "https://idp.example/",
      }),
    ).toThrow(/same issuer/);
  });

  it("refuses an id that could not name an environment variable", () => {
    expect(() => registry({ OPENSESAME_PROVIDERS: "acme-sso" })).toThrow(
      /not a usable provider id/,
    );
  });
});

describe("loadConfig registry wiring", () => {
  /**
   * T3. `assertSecureConfig`'s credential-membership check is NOT
   * production-gated: a configured provider that never reached the allowlist
   * would take the whole process down at boot. Merging is what keeps the two
   * from ever disagreeing.
   */
  it("merges every registry issuer into the trusted allowlist", () => {
    const config = loadConfig({
      ...DEV,
      OPENSESAME_TRUSTED_UPSTREAMS: "https://shoo.dev",
      OPENSESAME_PROVIDERS: "google,github",
      OPENSESAME_PROVIDER_GOOGLE_CLIENT_ID: "google-cid",
      OPENSESAME_PROVIDER_GOOGLE_CLIENT_SECRET: "google-secret",
      OPENSESAME_PROVIDER_GITHUB_CLIENT_ID: "gh-cid",
      OPENSESAME_PROVIDER_GITHUB_CLIENT_SECRET: "gh-secret",
    });
    expect(config.trustedUpstreamIssuers).toEqual([
      "https://shoo.dev",
      "https://accounts.google.com",
      "https://github.com",
    ]);
    expect(() => assertSecureConfig(config, {})).not.toThrow();
  });

  it("absorbs the legacy upstream triple as a credentialed registry entry", () => {
    const config = loadConfig({
      ...DEV,
      OPENSESAME_TRUSTED_UPSTREAMS: "http://127.0.0.1:9090",
      OPENSESAME_UPSTREAM_ISSUER: "http://127.0.0.1:9090",
      OPENSESAME_UPSTREAM_CLIENT_ID: "opensesame-upstream",
      OPENSESAME_UPSTREAM_CLIENT_SECRET: "opensesame-upstream-secret",
    });
    // The legacy field keeps its meaning for the callers that already read it.
    expect(config.upstreamClientCredentials).toEqual({
      issuer: "http://127.0.0.1:9090",
      clientId: "opensesame-upstream",
      clientSecret: "opensesame-upstream-secret",
    });
    const absorbed = oidc(config.providers[0]);
    expect(absorbed.id).toBe("mock");
    // The label the login page has always shown for a loopback broker.
    expect(absorbed.label).toBe("a local test account");
    expect(absorbed.clientAuth).toBe("client_secret_post");
    expect(absorbed.clientSecret).toBe("opensesame-upstream-secret");
    expect(config.trustedUpstreamIssuers).toEqual(["http://127.0.0.1:9090"]);
  });

  it("lets an explicit provider entry win over the legacy triple", () => {
    const config = loadConfig({
      ...DEV,
      OPENSESAME_PROVIDERS: "keycloak",
      OPENSESAME_PROVIDER_KEYCLOAK_ISSUER: "https://kc.example.com",
      OPENSESAME_PROVIDER_KEYCLOAK_CLIENT_ID: "kc-cid",
      OPENSESAME_PROVIDER_KEYCLOAK_CLIENT_SECRET: "kc-secret",
      OPENSESAME_UPSTREAM_ISSUER: "https://kc.example.com",
      OPENSESAME_UPSTREAM_CLIENT_ID: "legacy-cid",
      OPENSESAME_UPSTREAM_CLIENT_SECRET: "legacy-secret",
    });
    expect(config.providers).toHaveLength(1);
    expect(oidc(config.providers[0]).clientId).toBe("kc-cid");
  });

  it("offers no providers when none are configured", () => {
    expect(loadConfig({ ...DEV }).providers).toEqual([]);
  });
});

function prodBase(): ControlPlaneConfig {
  return {
    host: "127.0.0.1",
    port: 8788,
    publicUrl: "https://id.example",
    issuer: "https://id.example",
    claimPepper: "unique-claim-pepper-not-dev",
    provisionalCookieName: "os_provisional",
    provisionalTtlMs: 86_400_000,
    logLevel: "info",
    allowPrincipalBearer: false,
    allowDevDefaults: false,
    bootstrapPersonalOrganization: false,
    isProduction: true,
    corsOrigins: ["https://app.example"],
    hostApiUrl: "https://host.example",
    operatorToken: "operator-secret",
    mappingResolveToken: "mapping-resolve-secret",
    trustedUpstreamIssuers: ["https://accounts.google.com"],
    providers: [],
    protocolFeatures: {
      oid4vp: false,
      oid4vci: false,
      fedcm: false,
      digitalCredentialsApi: false,
      openidFederation: false,
      sdJwtVc: false,
      tokenStatusList: false,
      presentationAgentIntents: false,
    },
  };
}

const GOOGLE: ProviderDescriptor = {
  id: "google",
  kind: "oidc",
  label: "Google",
  issuer: "https://accounts.google.com",
  scopes: "openid email profile",
  clientAuth: "client_secret_post",
  clientId: "google-cid",
  clientSecret: "google-secret",
};

describe("assertSecureConfig over the registry", () => {
  it("accepts a credentialed provider whose issuer is trusted", () => {
    expect(() =>
      assertSecureConfig({ ...prodBase(), providers: [GOOGLE] }, {}),
    ).not.toThrow();
  });

  it("refuses a credentialed provider outside the allowlist", () => {
    expect(() =>
      assertSecureConfig(
        {
          ...prodBase(),
          trustedUpstreamIssuers: ["https://shoo.dev"],
          providers: [GOOGLE],
        },
        {},
      ),
    ).toThrow(/not listed in OPENSESAME_TRUSTED_UPSTREAMS/);
  });

  it("refuses an http provider issuer in production", () => {
    // A secret-less provider skips the membership check, so this is the one
    // question left standing between it and a plaintext assertion in
    // production.
    expect(() =>
      assertSecureConfig(
        {
          ...prodBase(),
          providers: [
            {
              ...GOOGLE,
              id: "internal",
              issuer: "http://idp.internal",
              clientAuth: "none",
              clientId: "cid",
              clientSecret: undefined,
            },
          ],
        },
        {},
      ),
    ).toThrow(/https issuer in production/);
  });

  it("re-checks descriptor invariants on a config it did not parse", () => {
    expect(() =>
      assertSecureConfig(
        {
          ...prodBase(),
          providers: [{ ...GOOGLE, clientSecret: undefined }],
        },
        {},
      ),
    ).toThrow(/both required/);
  });

  it("still refuses the legacy credentialed issuer outside the allowlist", () => {
    // Byte-compatible with the pre-registry check, including its message.
    expect(() =>
      assertSecureConfig(
        {
          ...prodBase(),
          trustedUpstreamIssuers: ["https://shoo.dev"],
          upstreamClientCredentials: {
            issuer: "https://elsewhere.example",
            clientId: "cid",
            clientSecret: "shh",
          },
        },
        {},
      ),
    ).toThrow(/OPENSESAME_UPSTREAM_ISSUER carries client credentials/);
  });
});

describe("static provider lookup", () => {
  function configWith(
    trusted: string[],
    providers: ProviderDescriptor[],
  ): ControlPlaneConfig {
    return {
      ...prodBase(),
      isProduction: false,
      trustedUpstreamIssuers: trusted,
      providers,
    };
  }

  /**
   * An allowlisted issuer with no registry entry is still first-class: it
   * resolves to the public origin-profile client the pre-registry code used,
   * under the same id and label the login page has always shown.
   */
  it("synthesizes a public client for an allowlist-only issuer", () => {
    const config = configWith(
      ["https://shoo.dev", "http://127.0.0.1:9090", "https://idp.example.com"],
      [],
    );
    expect(staticProviders(config).map((p) => [p.id, p.label])).toEqual([
      ["shoo", "Google"],
      ["mock", "a local test account"],
      ["idp.example.com", "idp.example.com"],
    ]);
    expect(oidc(providerById(config, "shoo")).clientAuth).toBe("none");
  });

  it("lets a registry entry win over synthesis for the same issuer", () => {
    const config = configWith(["https://accounts.google.com"], [GOOGLE]);
    expect(staticProviders(config)).toEqual([GOOGLE]);
  });

  it("finds a provider by issuer regardless of trailing slashes", () => {
    const config = configWith(["https://accounts.google.com"], [GOOGLE]);
    expect(providerByIssuer(config, "https://accounts.google.com/")?.id).toBe(
      "google",
    );
    expect(providerByIssuer(config, "https://accounts.google.com")?.id).toBe(
      "google",
    );
    expect(providerByIssuer(config, "https://evil.example")).toBeUndefined();
    expect(providerByIssuer(config, "")).toBeUndefined();
  });

  it("carries the legacy credential onto the synthesized descriptor", () => {
    const config: ControlPlaneConfig = {
      ...configWith(["http://127.0.0.1:9090"], []),
      upstreamClientCredentials: {
        issuer: "http://127.0.0.1:9090",
        clientId: "opensesame-upstream",
        clientSecret: "opensesame-upstream-secret",
      },
    };
    expect(oidc(providerById(config, "mock")).clientAuth).toBe(
      "client_secret_post",
    );
  });

  /**
   * D7. Only the origin-profile brokers serve CORS on their token endpoint;
   * every shipped provider must be brokered server-side, which is the entire
   * reason the hosted login page exists.
   */
  it("flags only the origin-profile brokers as browser-capable", () => {
    const config = configWith(
      ["https://shoo.dev", "http://127.0.0.1:9090"],
      [GOOGLE],
    );
    expect(
      staticProviders(config).map((p) => [p.id, isBrowserCapable(p)]),
    ).toEqual([
      ["shoo", true],
      ["mock", true],
      ["google", false],
    ]);
  });

  it("does not call a credentialed loopback broker browser-capable", () => {
    // A confidential client cannot run in a browser: the secret would be in it.
    expect(
      isBrowserCapable({
        ...GOOGLE,
        id: "mock",
        issuer: "http://127.0.0.1:9090",
      }),
    ).toBe(false);
  });
});

const SHOO: ProviderDescriptor = {
  id: "shoo",
  kind: "oidc",
  label: "Google",
  issuer: "https://shoo.dev",
  scopes: "openid email profile",
  clientAuth: "none",
};

describe("provider hint precedence", () => {
  const providers: ProviderDescriptor[] = [SHOO, GOOGLE];

  /**
   * T7. `google` is shoo.dev's *label* and the Google provider's *id*. The id
   * is what a client asked for by name, so the id wins — otherwise the day a
   * real Google entry is configured, every `signIn({provider:"google"})` keeps
   * silently landing on the broker that fronts it.
   */
  it("resolves an ambiguous hint by id before label", () => {
    expect(matchProviderHint(providers, "google")?.id).toBe("google");
    expect(matchProviderHint(providers, "GOOGLE")?.id).toBe("google");
    expect(matchProviderHint(providers, "shoo")?.id).toBe("shoo");
  });

  it("falls back to issuer, then host, then label", () => {
    expect(matchProviderHint(providers, "https://shoo.dev")?.id).toBe("shoo");
    expect(matchProviderHint(providers, "shoo.dev")?.id).toBe("shoo");
    expect(matchProviderHint(providers, "accounts.google.com")?.id).toBe(
      "google",
    );
    // With no `google` id in the list, the label match is the answer.
    expect(matchProviderHint([SHOO], "google")?.id).toBe("shoo");
  });

  it.each([undefined, "", "   ", "unknown-provider"])(
    "ignores the unusable hint %p",
    (hint) => {
      expect(matchProviderHint(providers, hint)).toBeUndefined();
    },
  );
});

describe("buildLoginPageModel", () => {
  const config: ControlPlaneConfig = {
    ...prodBase(),
    isProduction: false,
    publicUrl: "https://id.example",
    trustedUpstreamIssuers: ["https://shoo.dev", "https://accounts.google.com"],
    providers: [GOOGLE],
  };

  const acme: Organization = {
    id: "org:1",
    slug: "acme",
    displayName: "Acme",
    state: "active",
    createdBy: "prn_owner",
    createdAt: new Date(),
    updatedAt: new Date(),
    ssoIssuer: "https://sso.acme.example",
  };

  function ctxWith(organizations: readonly Organization[]): AppContext {
    return overlapCast({
      config,
      stores: {
        organizations: {
          getBySlug: async (slug: string) =>
            organizations.find((candidate) => candidate.slug === slug),
        },
      },
    });
  }

  function details(hint?: string): InteractionDetails {
    return {
      uid: "uid-1",
      prompt: { name: "login" },
      params: {
        client_id: "origin:https://app.example",
        ...(hint !== undefined ? { login_hint_provider: hint } : undefined),
      },
    };
  }

  it("offers every static provider with its registry id", async () => {
    const model = await buildLoginPageModel(
      ctxWith([]),
      details(),
      "tok",
      undefined,
    );
    expect(model.federated?.upstreams).toEqual([
      { issuer: "https://shoo.dev", label: "Google", provider: "shoo" },
      {
        issuer: "https://accounts.google.com",
        label: "Google",
        provider: "google",
      },
    ]);
    expect(model.byo?.startAction).toBe("/interaction/uid-1/federated/byo");
    expect(model.org?.lookupAction).toBe("/interaction/uid-1/federated/org");
    expect(model.email?.requestAction).toBe(
      "/interaction/uid-1/federated/email",
    );
    expect(model.realm?.requestAction).toBe(
      "/interaction/uid-1/federated/realm",
    );
  });

  it("marks the hinted provider preferred, by id ahead of label", async () => {
    const model = await buildLoginPageModel(
      ctxWith([]),
      details("google"),
      "tok",
      undefined,
    );
    // Preferred only — the page renders it first and primary, and does not
    // redirect on its own: an upstream error returns here, and a page that
    // auto-submitted would loop forever (T14).
    expect(model.federated?.preferredIssuer).toBe(
      "https://accounts.google.com",
    );
  });

  it("renders a resolved organization's methods for `?org=<slug>`", async () => {
    const model = await buildLoginPageModel(
      ctxWith([acme]),
      details(),
      "tok",
      undefined,
      { orgSlug: "acme" },
    );
    expect(model.org).toEqual({
      lookupAction: "/interaction/uid-1/federated/org",
      slug: "acme",
      methods: [
        { kind: "sso", label: "SSO", issuer: "https://sso.acme.example" },
      ],
    });
  });

  it("answers an unknown and a method-less tenant identically", async () => {
    const unknown = await buildLoginPageModel(
      ctxWith([acme]),
      details(),
      "tok",
      undefined,
      { orgSlug: "not-a-tenant" },
    );
    const methodless = await buildLoginPageModel(
      ctxWith([{ ...acme, slug: "bare", ssoIssuer: undefined }]),
      details(),
      "tok",
      undefined,
      { orgSlug: "bare" },
    );
    // Anti-enumeration: an unauthenticated page must not tell a stranger which
    // organization slugs exist.
    expect(unknown.org?.error).toBe(methodless.org?.error);
    expect(unknown.org?.methods).toBeUndefined();
  });

  it("carries each block's re-render state back to the page", async () => {
    const model = await buildLoginPageModel(
      ctxWith([]),
      details(),
      "tok",
      "prn_1",
      {
        byoError: "That provider could not be reached.",
        byoIssuer: "https://id.example.com",
        emailSent: true,
        realmError: "No organization uses that email domain.",
      },
    );
    expect(model.principalId).toBe("prn_1");
    expect(model.byo).toEqual({
      startAction: "/interaction/uid-1/federated/byo",
      error: "That provider could not be reached.",
      issuerValue: "https://id.example.com",
    });
    expect(model.email?.sent).toBe(true);
    expect(model.realm?.error).toBe("No organization uses that email domain.");
  });
});

describe("resolveTrustedIssuer", () => {
  const config: ControlPlaneConfig = {
    ...prodBase(),
    isProduction: false,
    trustedUpstreamIssuers: ["https://shoo.dev", "https://accounts.google.com"],
    providers: [GOOGLE],
  };

  const activeByo: ByoUpstream = {
    id: "byo_1",
    issuer: "https://byo.example",
    label: "byo.example",
    clientId: "byo-cid",
    clientAuth: "none",
    registrationSource: "manual",
    state: "active",
    createdAt: new Date(),
  };

  const org: Organization = {
    id: "org:1",
    slug: "acme",
    displayName: "Acme",
    state: "active",
    createdBy: "prn_owner",
    createdAt: new Date(),
    updatedAt: new Date(),
    ssoIssuer: "https://sso.acme.example",
    samlIssuer: "https://saml.acme.example",
  };

  /**
   * The stores as C6 specifies them: BYO lookup by issuer, organization lookup
   * across BOTH issuer columns.
   */
  function ctxWith(
    byoRecords: readonly ByoUpstream[],
    organizations: readonly Organization[],
  ): AppContext {
    return overlapCast({
      config,
      repos: {
        byoUpstreams: {
          findByIssuer: async (issuer: string) =>
            byoRecords.find((record) => record.issuer === issuer) ?? null,
        },
      },
      stores: {
        organizations: {
          findByIssuer: async (issuer: string) =>
            organizations.find(
              (candidate) =>
                candidate.ssoIssuer === issuer ||
                candidate.samlIssuer === issuer,
            ),
        },
      },
    });
  }

  it("resolves a registry provider first", async () => {
    const ctx = ctxWith(
      [{ ...activeByo, issuer: "https://accounts.google.com" }],
      [{ ...org, ssoIssuer: "https://accounts.google.com" }],
    );
    // The operator's entry is the one carrying the client credentials; a BYO
    // record or an org row naming the same issuer must never shadow it.
    expect(
      await resolveTrustedIssuer(ctx, "https://accounts.google.com/"),
    ).toEqual({ source: "static", provider: GOOGLE });
  });

  it("resolves an allowlisted issuer with no registry entry", async () => {
    const resolution = await resolveTrustedIssuer(
      ctxWith([], []),
      "https://shoo.dev",
    );
    expect(resolution?.source).toBe("static");
  });

  it("resolves an active BYO upstream", async () => {
    const ctx = ctxWith([activeByo], []);
    expect(await resolveTrustedIssuer(ctx, "https://byo.example/")).toEqual({
      source: "byo",
      record: activeByo,
    });
  });

  it("refuses a disabled BYO upstream", async () => {
    const ctx = ctxWith([{ ...activeByo, state: "disabled" }], []);
    expect(
      await resolveTrustedIssuer(ctx, "https://byo.example"),
    ).toBeUndefined();
  });

  it("resolves an organization by either of its issuers", async () => {
    const ctx = ctxWith([], [org]);
    expect(await resolveTrustedIssuer(ctx, "https://sso.acme.example")).toEqual(
      {
        source: "org",
        organizationId: "org:1",
        issuer: "https://sso.acme.example",
        method: "sso",
      },
    );
    expect(
      await resolveTrustedIssuer(ctx, "https://saml.acme.example"),
    ).toEqual({
      source: "org",
      organizationId: "org:1",
      issuer: "https://saml.acme.example",
      method: "saml",
    });
  });

  it("refuses a suspended organization", async () => {
    const ctx = ctxWith([], [{ ...org, state: "suspended" }]);
    expect(
      await resolveTrustedIssuer(ctx, "https://sso.acme.example"),
    ).toBeUndefined();
  });

  it.each(["https://evil.example", "", "   "])(
    "answers undefined for %p, which callers map to untrusted_issuer",
    async (issuer) => {
      expect(
        await resolveTrustedIssuer(ctxWith([], []), issuer),
      ).toBeUndefined();
    },
  );

  it("answers a static issuer without reading either store", async () => {
    // The order in C2 is not cosmetic: the operator's entry carries the client
    // credentials, so it must be decided before anything a visitor or a tenant
    // owner could have written. A store that throws proves it is never asked.
    const refuses = () => {
      throw new Error("store consulted for a static issuer");
    };
    const fenced: AppContext = overlapCast({
      config,
      repos: { byoUpstreams: { findByIssuer: refuses } },
      stores: { organizations: { findByIssuer: refuses } },
    });
    expect(
      (await resolveTrustedIssuer(fenced, "https://shoo.dev"))?.source,
    ).toBe("static");
    expect(
      (await resolveTrustedIssuer(fenced, "https://accounts.google.com"))
        ?.source,
    ).toBe("static");
  });
});

describe("GET /v1/federated/providers", () => {
  it("publishes ids, labels and kinds — and nothing about the topology", async () => {
    const { app } = createControlPlane({
      processEnv: {
        ...process.env,
        OPENSESAME_ALLOW_DEV_DEFAULTS: "true",
        OPENSESAME_TRUSTED_UPSTREAMS: "https://shoo.dev,http://127.0.0.1:9090",
        OPENSESAME_PROVIDERS: "google,github",
        OPENSESAME_PROVIDER_GOOGLE_CLIENT_ID: "google-cid",
        OPENSESAME_PROVIDER_GOOGLE_CLIENT_SECRET: "google-secret",
        OPENSESAME_PROVIDER_GITHUB_CLIENT_ID: "gh-cid",
        OPENSESAME_PROVIDER_GITHUB_CLIENT_SECRET: "gh-secret",
      },
    });

    // Public: the Pages first-run screen reads it before anyone has a session.
    const res = await app.request("/v1/federated/providers");
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(JSON.parse(body)).toEqual({
      providers: [
        { id: "shoo", label: "Google", kind: "oidc", browserCapable: true },
        {
          id: "mock",
          label: "a local test account",
          kind: "oidc",
          browserCapable: true,
        },
        { id: "google", label: "Google", kind: "oidc", browserCapable: false },
        {
          id: "github",
          label: "GitHub",
          kind: "oauth2",
          browserCapable: false,
        },
      ],
    });

    for (const leaked of [
      "accounts.google.com",
      "github.com",
      "shoo.dev",
      "127.0.0.1",
      "google-cid",
      "google-secret",
      "gh-cid",
      "gh-secret",
      "login/oauth",
      "api.github.com",
    ]) {
      expect(body).not.toContain(leaked);
    }
  });
});

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
