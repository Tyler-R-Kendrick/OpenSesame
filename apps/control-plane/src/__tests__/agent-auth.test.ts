import { PROVIDER_ID_JAG_TYP } from "@opensesame/agent-protocols";
import { overlapCast } from "@opensesame/os-domain";
import { generateClaimToken } from "@opensesame/os-domain";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  agentAuthRuntime,
  resetAgentAuthRuntimeForTests,
} from "../services/agent-auth.js";

async function app() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
    },
  }).app;
}

async function json(res: Response) {
  return overlapCast(await res.json());
}

async function verifiedWithEmail(
  hono: ReturnType<typeof createControlPlane>["app"],
  email: string,
) {
  const created = await hono.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(created.status).toBe(201);
  const body = await json(created);
  const auth = { authorization: `Bearer ${body.accessToken}` };
  const linked = await hono.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": `verify-${email}`,
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject: `sub-${email}`,
      emailNormalized: email,
      emailVerified: true,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return { auth, principalId: body.principalId as string };
}

describe("AgentAuth registration", () => {
  it("registers anonymously, exchanges a service assertion, and enforces pre-claim scopes", async () => {
    const hono = await app();
    const registered = await hono.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "anonymous" }),
    });
    expect(registered.status).toBe(200);
    const body = await json(registered);
    expect(body.registration_id).toMatch(/^areg_/);
    expect(body.claim_token).toMatch(/^clm_/);
    expect(body.identity_assertion).toBeTruthy();
    expect(body.pre_claim_scopes).toContain("resource:read");

    const tokenRes = await hono.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: String(body.identity_assertion),
      }),
    });
    expect(tokenRes.status).toBe(200);
    const token = await json(tokenRes);
    expect(token.access_token).toMatch(/^aat_/);
    expect(token.refresh_token).toBeUndefined();
    expect(String(token.scope)).not.toContain("claim:create");

    const demo = await hono.request("/v1/agent-resources/demo", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(demo.status).toBe(200);
    const demoBody = await json(demo);
    expect(demoBody.claimed).toBe(false);
    expect(demoBody.registration_id).toBe(body.registration_id);
  });

  it("upgrades anonymous → claimed without merging principals or widening the old token", async () => {
    const hono = await app();
    const registered = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "anonymous" }),
      }),
    );
    const preToken = await json(
      await hono.request("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: String(registered.identity_assertion),
        }),
      }),
    );

    const started = await json(
      await hono.request("/agent/identity/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim_token: registered.claim_token,
          email: "owner@example.com",
        }),
      }),
    );
    expect(started.status ?? "initiated").toBeDefined();
    const userCode = overlapCast(started.claim_attempt).user_code as string;
    const verificationUri = new URL(
      String(overlapCast(started.claim_attempt).verification_uri),
    );
    const returnTo = verificationUri.searchParams.get("return_to") ?? "";
    const claimAttemptToken = new URL(
      returnTo,
      "http://127.0.0.1:8788",
    ).searchParams.get("claim_attempt_token");
    expect(claimAttemptToken).toBeTruthy();

    const human = await verifiedWithEmail(hono, "owner@example.com");
    const completed = await hono.request("/agent/identity/claim/complete", {
      method: "POST",
      headers: {
        ...human.auth,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        claim_attempt_token: claimAttemptToken,
        user_code: userCode,
      }),
    });
    expect(completed.status).toBe(200);

    const stale = await hono.request("/v1/agent-resources/demo", {
      headers: { authorization: `Bearer ${preToken.access_token}` },
    });
    expect(stale.status).toBe(401);

    const polled = await hono.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:workos:agent-auth:grant-type:claim",
        claim_token: String(registered.claim_token),
      }),
    });
    expect(polled.status).toBe(200);
    const post = await json(polled);
    expect(String(post.scope)).toContain("claim:create");
    expect(post.identity_assertion).toBeTruthy();
    expect(post.identity_assertion).not.toBe(registered.identity_assertion);

    const demo = await json(
      await hono.request("/v1/agent-resources/demo", {
        headers: { authorization: `Bearer ${post.access_token}` },
      }),
    );
    expect(demo.claimed).toBe(true);
    expect(demo.registration_id).toBe(registered.registration_id);
  });

  it("does not issue a service assertion for service_auth until claimed", async () => {
    const hono = await app();
    const registered = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "service_auth",
          login_hint: "hint@example.com",
        }),
      }),
    );
    expect(registered.identity_assertion).toBeUndefined();
    expect(registered.claim).toBeTruthy();
  });

  it("refuses provider ID-JAG registration while the trust path is disabled", async () => {
    const hono = await app();
    const res = await hono.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion: "eyJhbGc.e30.sig",
      }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: "identity_assertion_not_enabled",
    });
  });

  it("rejects token confusion across artifact types", async () => {
    const hono = await app();
    const registered = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "anonymous" }),
      }),
    );
    const provisional = await json(
      await hono.request("/v1/principals/provisional", { method: "POST" }),
    );
    const productClaim = generateClaimToken("dev-claim-pepper-change-me");

    const pstAsAssertion = await hono.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: String(provisional.accessToken),
      }),
    });
    expect(pstAsAssertion.status).toBe(400);

    const claimAsAssertion = await hono.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: String(registered.claim_token),
      }),
    });
    expect(claimAsAssertion.status).toBe(400);

    const productClaimAsAgent = await hono.request("/agent/identity/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim_token: productClaim.token }),
    });
    expect(productClaimAsAgent.status).toBe(400);

    const { privateKey } = await generateKeyPair("ES256");
    const idJag = await new SignJWT({ sub: "user" })
      .setProtectedHeader({ alg: "ES256", typ: PROVIDER_ID_JAG_TYP })
      .setIssuer("https://provider.example")
      .setAudience("http://127.0.0.1:8788")
      .setExpirationTime("5m")
      .sign(privateKey);
    const idJagAsService = await hono.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: idJag,
      }),
    });
    expect(idJagAsService.status).toBe(400);

    const token = await json(
      await hono.request("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: String(registered.identity_assertion),
        }),
      }),
    );
    const accessAsAssertion = await hono.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: String(token.access_token),
      }),
    });
    expect(accessAsAssertion.status).toBe(400);
  });

  it("revokes an access token without killing the assertion", async () => {
    const hono = await app();
    const registered = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "anonymous" }),
      }),
    );
    const token = await json(
      await hono.request("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: String(registered.identity_assertion),
        }),
      }),
    );
    const revoked = await hono.request("/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: String(token.access_token),
        token_type_hint: "access_token",
      }),
    });
    expect(revoked.status).toBe(200);
    const dead = await hono.request("/v1/agent-resources/demo", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(dead.status).toBe(401);
    const refreshed = await hono.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: String(registered.identity_assertion),
      }),
    });
    expect(refreshed.status).toBe(200);
  });

  it("advertises only enabled AgentAuth capabilities", async () => {
    const hono = await app();
    const md = await (await hono.request("/auth.md")).text();
    expect(md).toContain("/agent/identity");
    expect(md).toContain("not advertised and not enabled");
    const as = await json(
      await hono.request("/.well-known/oauth-authorization-server"),
    );
    expect(overlapCast(as.agent_auth).identity_types_supported).toEqual([
      "anonymous",
      "service_auth",
    ]);
    expect(overlapCast(as.agent_auth).events_endpoint).toBeUndefined();
    expect(overlapCast(as.agent_auth).identity_assertion).toBeUndefined();
    const prm = await json(
      await hono.request("/.well-known/oauth-protected-resource"),
    );
    expect(prm.authorization_servers).toEqual(["http://127.0.0.1:8788"]);
  });

  it("refuses jwt-bearer exchange after the registration TTL", async () => {
    let now = new Date("2026-09-02T12:00:00.000Z");
    const hono = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
      clock: () => now,
    }).app;
    const registered = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "anonymous" }),
      }),
    );
    now = new Date(now.getTime() + 86_400_001);
    const stale = await hono.request("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: String(registered.identity_assertion),
      }),
    });
    expect(stale.status).toBe(400);
  });
});

describe("AgentAuth provider ID-JAG", () => {
  async function providerApp() {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const jwk = await exportJWK(publicKey);
    jwk.kid = "idp-1";
    jwk.alg = "ES256";
    const hono = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
      processEnv: {
        OPENSESAME_ALLOW_DEV_DEFAULTS: "true",
        OPENSESAME_AGENT_AUTH_PROVIDER_ASSERTION_ENABLED: "true",
        OPENSESAME_AGENT_AUTH_TRUSTED_PROVIDERS_JSON: JSON.stringify([
          {
            issuer: "https://idp.example",
            enabled: true,
            audiences: ["http://127.0.0.1:8788"],
            algorithms: ["ES256"],
            maxAgeSeconds: 600,
            jwks: { keys: [jwk] },
          },
        ]),
      },
    }).app;
    return { hono, privateKey };
  }

  async function idJag(
    privateKey: CryptoKey,
    overrides: {
      iss?: string;
      aud?: string;
      jti?: string;
      sub?: string;
      email?: string;
      emailVerified?: boolean;
      authTimeOffset?: number;
      omitAuthTime?: boolean;
    } = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      sub: overrides.sub ?? "user_idp_1",
      email: overrides.email ?? "idp-user@example.com",
      email_verified: overrides.emailVerified ?? true,
    };
    if (!overrides.omitAuthTime) {
      claims.auth_time = now + (overrides.authTimeOffset ?? 0);
    }
    return new SignJWT(claims)
      .setProtectedHeader({
        alg: "ES256",
        typ: PROVIDER_ID_JAG_TYP,
        kid: "idp-1",
      })
      .setIssuer(overrides.iss ?? "https://idp.example")
      .setAudience(overrides.aud ?? "http://127.0.0.1:8788")
      .setJti(
        overrides.jti ?? `jti-${now}-${Math.random().toString(16).slice(2)}`,
      )
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
  }

  it("registers from a trusted ID-JAG and exchanges a service assertion", async () => {
    const { hono, privateKey } = await providerApp();
    const assertion = await idJag(privateKey);
    const registered = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "identity_assertion",
          assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
          assertion,
        }),
      }),
    );
    expect(registered.registration_type).toBe("identity_assertion");
    expect(registered.identity_assertion).toBeTruthy();
    const token = await json(
      await hono.request("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: String(registered.identity_assertion),
        }),
      }),
    );
    expect(token.access_token).toMatch(/^aat_/);
    expect(token.refresh_token).toBeUndefined();
    const as = await json(
      await hono.request("/.well-known/oauth-authorization-server"),
    );
    expect(overlapCast(as.agent_auth).identity_types_supported).toContain(
      "identity_assertion",
    );
    expect(overlapCast(as.agent_auth).events_endpoint).toBeUndefined();
    const sia = String(registered.identity_assertion).split(".")[1] ?? "";
    const payload = JSON.parse(
      Buffer.from(sia, "base64url").toString("utf8"),
    ) as { act?: { sub?: string }; sub?: string };
    expect(payload.act?.sub).toMatch(/^osact_/);
    expect(payload.act?.sub).not.toMatch(/^prn_/);
    expect(String(payload.sub)).toMatch(/^areg_/);
  });

  it("rejects an untrusted issuer and a replayed jti", async () => {
    const { hono, privateKey } = await providerApp();
    const foreign = await idJag(privateKey, { iss: "https://evil.example" });
    const untrusted = await hono.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion: foreign,
      }),
    });
    expect(untrusted.status).toBe(400);
    expect(await json(untrusted)).toMatchObject({
      error: "issuer_not_enabled",
    });

    const assertion = await idJag(privateKey, { jti: "replay-1" });
    const first = await hono.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion,
      }),
    });
    expect(first.status).toBe(200);
    const second = await hono.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion,
      }),
    });
    expect(second.status).toBe(400);
  });

  it("does not auto-bind by verified email", async () => {
    const { hono, privateKey } = await providerApp();
    await verifiedWithEmail(hono, "taken@example.com");
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({
      sub: "other-sub",
      email: "taken@example.com",
      email_verified: true,
      auth_time: now,
    })
      .setProtectedHeader({
        alg: "ES256",
        typ: PROVIDER_ID_JAG_TYP,
        kid: "idp-1",
      })
      .setIssuer("https://idp.example")
      .setAudience("http://127.0.0.1:8788")
      .setJti(`jti-email-${now}`)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    const res = await hono.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion,
      }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/interaction_required/);
    const body = await json(res);
    expect(body).toMatchObject({
      error: "interaction_required",
      registration_type: "identity_assertion",
    });
    expect(body.claim).toBeTruthy();
    expect(body.claim_token).toMatch(/^clm_/);
    expect(body.identity_assertion).toBeUndefined();
  });

  it("refuses a loopback jwks_uri on a remote issuer", async () => {
    const hono = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
      processEnv: {
        OPENSESAME_ALLOW_DEV_DEFAULTS: "true",
        OPENSESAME_AGENT_AUTH_PROVIDER_ASSERTION_ENABLED: "true",
        OPENSESAME_AGENT_AUTH_TRUSTED_PROVIDERS_JSON: JSON.stringify([
          {
            issuer: "https://idp.example",
            enabled: true,
            audiences: ["http://127.0.0.1:8788"],
            jwksUri: "http://127.0.0.1/jwks",
          },
        ]),
      },
    }).app;
    const { privateKey } = await generateKeyPair("ES256");
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({
      sub: "user",
      email: "ssrf@example.com",
      email_verified: true,
      auth_time: now,
    })
      .setProtectedHeader({ alg: "ES256", typ: PROVIDER_ID_JAG_TYP })
      .setIssuer("https://idp.example")
      .setAudience("http://127.0.0.1:8788")
      .setJti("jti-ssrf")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    const res = await hono.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a stale auth_time with login_required", async () => {
    const { hono, privateKey } = await providerApp();
    const assertion = await idJag(privateKey, { authTimeOffset: -10_000 });
    const res = await hono.request("/agent/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion,
      }),
    });
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ error: "login_required" });
    expect(res.headers.get("www-authenticate")).toMatch(/login_required/);
  });

  it("does not advertise identity_assertion without a trusted provider", async () => {
    const hono = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
      processEnv: {
        OPENSESAME_ALLOW_DEV_DEFAULTS: "true",
        OPENSESAME_AGENT_AUTH_PROVIDER_ASSERTION_ENABLED: "true",
        OPENSESAME_AGENT_AUTH_EVENTS_ENABLED: "true",
      },
    }).app;
    const as = await json(
      await hono.request("/.well-known/oauth-authorization-server"),
    );
    expect(overlapCast(as.agent_auth).identity_types_supported).toEqual([
      "anonymous",
      "service_auth",
    ]);
    expect(overlapCast(as.agent_auth).events_endpoint).toBeUndefined();
    const md = await (await hono.request("/auth.md")).text();
    expect(md).toMatch(/not advertised and not enabled/);
  });

  it("completes first-link then accepts a later ID-JAG for the same tuple", async () => {
    const { hono, privateKey } = await providerApp();
    const human = await verifiedWithEmail(hono, "owner@example.com");
    const first = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "identity_assertion",
          assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
          assertion: await idJag(privateKey, {
            sub: "link-sub",
            email: "owner@example.com",
            jti: "jti-first-link",
          }),
        }),
      }),
    );
    expect(first.error).toBe("interaction_required");
    const userCode = overlapCast(first.claim).user_code as string;
    const verificationUri = new URL(
      String(overlapCast(first.claim).verification_uri),
    );
    const returnTo = verificationUri.searchParams.get("return_to") ?? "";
    const claimAttemptToken = new URL(
      returnTo,
      "http://127.0.0.1:8788",
    ).searchParams.get("claim_attempt_token");
    const completed = await hono.request("/agent/identity/claim/complete", {
      method: "POST",
      headers: {
        ...human.auth,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        claim_attempt_token: claimAttemptToken,
        user_code: userCode,
      }),
    });
    expect(completed.status).toBe(200);

    const registered = await json(
      await hono.request("/agent/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "identity_assertion",
          assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
          assertion: await idJag(privateKey, {
            sub: "link-sub",
            email: "owner@example.com",
            jti: "jti-after-link",
          }),
        }),
      }),
    );
    expect(registered.registration_type).toBe("identity_assertion");
    expect(registered.identity_assertion).toBeTruthy();
  });
});

describe("AgentAuth service assertion keys", () => {
  afterEach(() => {
    resetAgentAuthRuntimeForTests();
  });

  it("refuses an ephemeral signing key in production", async () => {
    resetAgentAuthRuntimeForTests();
    await expect(agentAuthRuntime({ NODE_ENV: "production" })).rejects.toThrow(
      /OPENSESAME_JWKS_JSON|OPENSESAME_AGENT_AUTH_SIA_JWK/,
    );
  });
});
