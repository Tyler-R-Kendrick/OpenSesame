import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ControlPlaneConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { AppContext } from "../context.js";
import {
  FederatedAuthError,
  resetFederatedDiscoveryCache,
} from "../interactions/federated.js";
import { beginOAuth2Auth, completeOAuth2Auth } from "../interactions/oauth2.js";
import type { OAuth2ProviderDescriptor } from "../interactions/registry.js";
import { providerById } from "../interactions/registry.js";

/**
 * The generic OAuth2 leg, against a real GitHub-shaped authorization server.
 *
 * The counterparty is the reference IdP (C18) speaking the real wire protocol
 * over real HTTP, including the three GitHub quirks that a JSON-only client
 * silently mis-reads (T15): a form-encoded token response unless the request
 * asked for JSON, protocol errors delivered as HTTP 200 with an `error` key,
 * and a numeric profile `id`. Nothing here simulates those behaviours per test
 * — they are how that server actually answers.
 *
 * The provider descriptor comes from the real registry parser with the
 * reference IdP's endpoints substituted for github.com's, so the shipped
 * GitHub defaults (scope `read:user`, subject field `id`) are the ones under
 * test.
 */

const PUBLIC_URL = "http://127.0.0.1:4318";
const UID = "int_oauth2";
/**
 * The stable, deployment-wide callback (ADR 0055) — not a path naming this
 * interaction. A registry provider's redirect URI is registered once, in a
 * console, and matched byte for byte, so it cannot carry a uid.
 */
const CALLBACK = `${PUBLIC_URL}/v1/federated/callback`;

/**
 * The provider variables a case may vary, layered onto the real config loader.
 * Spelled out rather than left an open dictionary: a typo in a variable name
 * would otherwise silently test the default configuration instead.
 */
type EnvOverrides = {
  OPENSESAME_PROVIDER_GITHUB_TOKEN_URL?: string;
  OPENSESAME_PROVIDER_GITHUB_USERINFO_URL?: string;
  OPENSESAME_PROVIDER_GITHUB_CLIENT_SECRET?: string;
  OPENSESAME_PROVIDER_GITHUB_SUBJECT_FIELD?: string;
};

/** The one thing the relay is allowed to change about a real request. */
type TokenRelayOptions = { stripAccept?: boolean };

type TokenRelay = {
  url: string;
  acceptSeen: () => string | undefined;
  close: () => Promise<void>;
};

/**
 * A reverse proxy in front of the reference IdP's token endpoint.
 *
 * It forwards the real request to the real server and returns the real
 * response; the only thing it changes is whether our `Accept` header survives
 * the trip. That is the one condition GitHub's response encoding turns on, and
 * there is no other way to observe it from the client side.
 */
async function startTokenRelay(
  tokenUrl: string,
  options: TokenRelayOptions = {},
): Promise<TokenRelay> {
  let acceptSeen: string | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      void (async () => {
        const accept = req.headers.accept;
        acceptSeen = accept;
        const forwarded =
          options.stripAccept !== true && accept !== undefined
            ? { accept }
            : undefined;
        const upstream = await fetch(tokenUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...forwarded,
          },
          body,
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(text);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: server.listen established the runtime AddressInfo invariant.
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/login/oauth/access_token`,
    acceptSeen: () => acceptSeen,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

let idp: ReferenceIdp;
let ctx: AppContext;
let github: OAuth2ProviderDescriptor;

function configFor(overrides: EnvOverrides = {}): ControlPlaneConfig {
  return loadConfig({
    ...process.env,
    OPENSESAME_PUBLIC_URL: PUBLIC_URL,
    OPENSESAME_PROVIDERS: "github",
    OPENSESAME_PROVIDER_GITHUB_ISSUER: idp.issuer,
    OPENSESAME_PROVIDER_GITHUB_AUTHORIZE_URL: idp.oauth2.authorizeUrl,
    OPENSESAME_PROVIDER_GITHUB_TOKEN_URL: idp.oauth2.tokenUrl,
    OPENSESAME_PROVIDER_GITHUB_USERINFO_URL: idp.oauth2.userinfoUrl,
    OPENSESAME_PROVIDER_GITHUB_CLIENT_ID: idp.oauth2.clientId,
    OPENSESAME_PROVIDER_GITHUB_CLIENT_SECRET: idp.oauth2.clientSecret,
    ...overrides,
  });
}

/** The registry entry as configured, refusing anything but an oauth2 one. */
function oauth2Provider(config: ControlPlaneConfig): OAuth2ProviderDescriptor {
  const descriptor = providerById(config, "github");
  if (descriptor?.kind !== "oauth2") {
    throw new Error("github must parse as an oauth2 provider");
  }
  return descriptor;
}

function contextFor(config: ControlPlaneConfig): AppContext {
  // SAFETY: this leg reads `config.publicUrl` and nothing else from the
  // context — the protocol counterparty is the real server, not this object.
  return overlapCast({ config });
}

/** Drive the provider's real /authorize and return where it sent us back. */
async function authorize(authorizationUrl: string): Promise<URL> {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location") ?? "");
}

beforeAll(async () => {
  resetFederatedDiscoveryCache();
  idp = await startReferenceIdp({ protocol: "oauth2" });
  const config = configFor();
  ctx = contextFor(config);
  github = oauth2Provider(config);
}, 30_000);

afterAll(async () => {
  await idp.close();
  resetFederatedDiscoveryCache();
});

describe("starting the oauth2 leg", () => {
  it("sends the browser to the provider with PKCE S256 and the configured scope", async () => {
    const start = await beginOAuth2Auth(ctx, UID, github);
    const url = new URL(start.authorizationUrl);

    expect(url.origin).toBe(idp.issuer);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(idp.oauth2.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    // Only what a sign-in needs; `user:email` is a different question (T15).
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    // `state` names the interaction, which is how the shared callback knows
    // which one to hand the browser back to.
    expect(url.searchParams.get("state")).toMatch(new RegExp(`^${UID}\\..+`));
  });

  it("asks for no id_token and carries no nonce", async () => {
    // The point of this leg: there is no assertion, so there is nothing for a
    // nonce to bind. A nonce here would imply a verification that never runs.
    const start = await beginOAuth2Auth(ctx, UID, github);
    const url = new URL(start.authorizationUrl);

    expect(url.searchParams.get("nonce")).toBeNull();
    expect(url.searchParams.get("scope")).not.toContain("openid");
    expect(start.pending.nonce).toBe("");
  });

  it("stashes the leg kind and the registry id for the callback", async () => {
    const start = await beginOAuth2Auth(ctx, UID, github);

    expect(start.pending).toMatchObject({
      issuer: idp.issuer,
      kind: "oauth2",
      providerId: "github",
    });
    expect(start.pending.verifier).toBeTruthy();
  });

  it("mints a fresh state and verifier per attempt", async () => {
    const first = await beginOAuth2Auth(ctx, UID, github);
    const second = await beginOAuth2Auth(ctx, UID, github);

    expect(first.pending.state).not.toBe(second.pending.state);
    expect(first.pending.verifier).not.toBe(second.pending.verifier);
  });
});

describe("finishing the oauth2 leg", () => {
  it("admits the account the provider describes", async () => {
    const start = await beginOAuth2Auth(ctx, UID, github);
    const back = await authorize(start.authorizationUrl);

    const identity = await completeOAuth2Auth(ctx, github, start.pending, back);

    expect(identity).toEqual({
      kind: "oauth2",
      issuer: idp.issuer,
      // Numeric and immutable — never the renameable `login`.
      subject: String(idp.oauth2.userId),
      email: "mock@example.com",
      name: "Mock User",
    });
    expect(identity.subject).not.toBe(idp.oauth2.login);
  });

  it("claims nothing about whether the address was verified", async () => {
    // GitHub's /user says only what the address is. Asserting verification the
    // provider never made would feed the verified-email auto-link a lie.
    const start = await beginOAuth2Auth(ctx, UID, github);
    const back = await authorize(start.authorizationUrl);

    const identity = await completeOAuth2Auth(ctx, github, start.pending, back);

    expect(identity.emailVerified).toBeUndefined();
  });

  it("refuses a callback whose state is not the one this browser started", async () => {
    const start = await beginOAuth2Auth(ctx, UID, github);
    const back = await authorize(start.authorizationUrl);
    back.searchParams.set("state", "tampered");

    await expect(
      completeOAuth2Auth(ctx, github, start.pending, back),
    ).rejects.toMatchObject({
      name: "FederatedAuthError",
      code: "exchange_failed",
    });
  });

  it("refuses a callback with no code at all", async () => {
    const start = await beginOAuth2Auth(ctx, UID, github);
    const back = new URL(CALLBACK);
    back.searchParams.set("state", start.pending.state);

    await expect(
      completeOAuth2Auth(ctx, github, start.pending, back),
    ).rejects.toMatchObject({ code: "exchange_failed" });
  });

  it("reads a refusal the provider delivered as HTTP 200", async () => {
    // GitHub burns the code on first use and answers the replay with
    // `bad_verification_code` — in a 200 body. A client that branched on the
    // status would call that a successful sign-in with no token.
    const start = await beginOAuth2Auth(ctx, UID, github);
    const back = await authorize(start.authorizationUrl);
    await completeOAuth2Auth(ctx, github, start.pending, back);

    await expect(
      completeOAuth2Auth(ctx, github, start.pending, back),
    ).rejects.toMatchObject({ code: "exchange_failed" });
  });

  it("refuses when the configured client secret is wrong", async () => {
    const wrongSecret = oauth2Provider(
      configFor({ OPENSESAME_PROVIDER_GITHUB_CLIENT_SECRET: "not-the-secret" }),
    );
    const start = await beginOAuth2Auth(ctx, UID, wrongSecret);
    const back = await authorize(start.authorizationUrl);

    // Also a 200 with an `error` key: `incorrect_client_credentials`.
    await expect(
      completeOAuth2Auth(ctx, wrongSecret, start.pending, back),
    ).rejects.toMatchObject({ code: "exchange_failed" });
  });

  it("refuses when the code was minted for a different verifier", async () => {
    const start = await beginOAuth2Auth(ctx, UID, github);
    const other = await beginOAuth2Auth(ctx, UID, github);
    const back = await authorize(start.authorizationUrl);

    await expect(
      completeOAuth2Auth(
        ctx,
        github,
        { ...start.pending, verifier: other.pending.verifier },
        back,
      ),
    ).rejects.toMatchObject({ code: "exchange_failed" });
  });
});

describe("the token response encoding", () => {
  it("asks the provider for JSON", async () => {
    const relay = await startTokenRelay(idp.oauth2.tokenUrl);
    try {
      const provider = oauth2Provider(
        configFor({ OPENSESAME_PROVIDER_GITHUB_TOKEN_URL: relay.url }),
      );
      const start = await beginOAuth2Auth(ctx, UID, provider);
      const back = await authorize(start.authorizationUrl);
      await completeOAuth2Auth(ctx, provider, start.pending, back);

      expect(relay.acceptSeen()).toContain("application/json");
    } finally {
      await relay.close();
    }
  });

  it("still reads the form-encoded answer a provider gives without it", async () => {
    // Drop the header on the way upstream and the real server answers
    // `application/x-www-form-urlencoded`, exactly as GitHub does by default.
    const relay = await startTokenRelay(idp.oauth2.tokenUrl, {
      stripAccept: true,
    });
    try {
      const provider = oauth2Provider(
        configFor({ OPENSESAME_PROVIDER_GITHUB_TOKEN_URL: relay.url }),
      );
      const start = await beginOAuth2Auth(ctx, UID, provider);
      const back = await authorize(start.authorizationUrl);

      const identity = await completeOAuth2Auth(
        ctx,
        provider,
        start.pending,
        back,
      );

      expect(identity.subject).toBe(String(idp.oauth2.userId));
    } finally {
      await relay.close();
    }
  });
});

describe("what counts as a subject", () => {
  it("refuses a profile with no value in the configured field", async () => {
    const provider = oauth2Provider(
      configFor({ OPENSESAME_PROVIDER_GITHUB_SUBJECT_FIELD: "employee_id" }),
    );
    const start = await beginOAuth2Auth(ctx, UID, provider);
    const back = await authorize(start.authorizationUrl);

    await expect(
      completeOAuth2Auth(ctx, provider, start.pending, back),
    ).rejects.toMatchObject({ code: "missing_subject" });
  });

  it("refuses a field holding something that is not a scalar", async () => {
    // Pointed at the provider's own metadata document — a real JSON body from
    // the real server whose `response_types_supported` is an array. Coercing a
    // structure into a subject would give every account the same one.
    const provider = oauth2Provider(
      configFor({
        OPENSESAME_PROVIDER_GITHUB_USERINFO_URL: idp.oauth2.metadataUrl,
        OPENSESAME_PROVIDER_GITHUB_SUBJECT_FIELD: "response_types_supported",
      }),
    );
    const start = await beginOAuth2Auth(ctx, UID, provider);
    const back = await authorize(start.authorizationUrl);

    await expect(
      completeOAuth2Auth(ctx, provider, start.pending, back),
    ).rejects.toMatchObject({ code: "missing_subject" });
  });

  it("refuses an unusable endpoint rather than admitting anonymously", async () => {
    const provider = oauth2Provider(
      configFor({ OPENSESAME_PROVIDER_GITHUB_TOKEN_URL: "not a url" }),
    );

    await expect(
      completeOAuth2Auth(
        ctx,
        provider,
        { issuer: provider.issuer, state: "s", nonce: "", verifier: "v" },
        new URL(`${CALLBACK}?code=c&state=s`),
      ),
    ).rejects.toBeInstanceOf(FederatedAuthError);
  });
});
