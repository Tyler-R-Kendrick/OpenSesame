import { PROVIDER_ID_JAG_TYP } from "@opensesame/agent-protocols";
import { overlapCast } from "@opensesame/os-domain";
import { generateClaimToken } from "@opensesame/os-domain";
import { SignJWT, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

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
