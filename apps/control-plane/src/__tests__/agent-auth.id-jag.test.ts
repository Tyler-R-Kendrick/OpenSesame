import { PROVIDER_ID_JAG_TYP } from "@opensesame/agent-protocols";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
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
  return { auth, principalId: String(body.principalId) };
}

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
        OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
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

  type IdJagOverrides = {
    iss?: string;
    aud?: string;
    jti?: string;
    sub?: string;
    email?: string;
    emailVerified?: boolean;
    authTimeOffset?: number;
    omitAuthTime?: boolean;
  };

  async function idJag(privateKey: CryptoKey, overrides: IdJagOverrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims: JsonObject = {
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
    // SAFETY: fixture constructed in this test matches the declared contract.
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
        OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
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
        OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
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
    // SAFETY: fixture constructed in this test matches the declared contract.
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
