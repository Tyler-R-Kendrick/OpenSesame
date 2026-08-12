import { describe, expect, it } from "vitest";
import {
  createPairwiseIdentifierCallback,
  MemoryPairwiseSubjectStore,
} from "@opensesame/oauth-provider";
import { createControlPlane } from "../create-app.js";

async function provisional(app: ReturnType<typeof createControlPlane>["app"]) {
  const res = await app.request("/v1/principals/provisional", { method: "POST" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    principalId: string;
    accessToken: string;
    sessionId: string;
  };
  return body;
}

describe("control-plane API", () => {
  it("creates provisional principal and returns /me", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const created = await provisional(app);
    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { id: string; state: string };
    expect(body.id).toBe(created.principalId);
    expect(body.state).toBe("provisional");
  });

  // Minting a session needs no credential, so an Idempotency-Key on it belongs to
  // nobody: replaying that answer would hand the first caller's bearer and cookie
  // to whoever quotes the key next.
  it("never replays a minted session to another caller", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const shared = { method: "POST", headers: { "idempotency-key": "mint-1" } };

    const first = await app.request("/v1/principals/provisional", shared);
    const second = await app.request("/v1/principals/provisional", shared);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotency-replayed")).toBeNull();

    const a = (await first.json()) as { principalId: string; accessToken: string };
    const b = (await second.json()) as { principalId: string; accessToken: string };
    expect(b.principalId).not.toBe(a.principalId);
    expect(b.accessToken).not.toBe(a.accessToken);
    expect(second.headers.get("set-cookie")).not.toBe(
      first.headers.get("set-cookie"),
    );
  });

  // The body says what to do, so the same key with a different one is a different
  // request: answering it with the first result would report a change never made.
  it("does not replay one key across different bodies", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const created = await provisional(app);
    const headers = {
      authorization: `Bearer ${created.accessToken}`,
      "content-type": "application/json",
      "idempotency-key": "proj-shared",
    };

    const first = await app.request("/v1/projects/temporary", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "First", ttlSeconds: 3600 }),
    });
    expect(first.status).toBe(201);

    const other = await app.request("/v1/projects/temporary", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Second", ttlSeconds: 3600 }),
    });
    expect(other.status).toBe(201);
    expect(other.headers.get("idempotency-replayed")).toBeNull();
    const one = (await first.json()) as { projectId: string };
    const two = (await other.json()) as { projectId: string };
    expect(two.projectId).not.toBe(one.projectId);

    // The same body still replays.
    const again = await app.request("/v1/projects/temporary", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "First", ttlSeconds: 3600 }),
    });
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(((await again.json()) as { projectId: string }).projectId).toBe(
      one.projectId,
    );
  });

  it("rejects provisional session id as Bearer or cookie credential", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const created = await provisional(app);
    expect(created.sessionId.startsWith("ps_")).toBe(true);
    expect(created.accessToken.startsWith("pst_")).toBe(true);

    const bySessionBearer = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.sessionId}` },
    });
    expect(bySessionBearer.status).toBe(401);

    const bySessionCookie = await app.request("/v1/principals/me", {
      headers: { cookie: `os_provisional=${created.sessionId}` },
    });
    expect(bySessionCookie.status).toBe(401);

    const byAccessCookie = await app.request("/v1/principals/me", {
      headers: { cookie: `os_provisional=${created.accessToken}` },
    });
    expect(byAccessCookie.status).toBe(200);
  });

  // The cookie authenticates on its own, so clearing the client is not enough.
  it("revokes a provisional session for bearer and cookie alike", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const created = await provisional(app);

    const revoked = await app.request("/v1/principals/provisional/revoke", {
      method: "POST",
      headers: { cookie: `os_provisional=${created.accessToken}` },
    });
    expect(revoked.status).toBe(204);
    expect(revoked.headers.get("set-cookie")).toContain("os_provisional=");

    const byCookie = await app.request("/v1/principals/me", {
      headers: { cookie: `os_provisional=${created.accessToken}` },
    });
    expect(byCookie.status).toBe(401);

    const byBearer = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(byBearer.status).toBe(401);
  });

  // An adopted CLI token has no cookie, so the bearer is the only handle on it.
  it("revokes a provisional session presented as a Bearer token", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const created = await provisional(app);

    const revoked = await app.request("/v1/principals/provisional/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(revoked.status).toBe(204);

    const after = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(after.status).toBe(401);
    // No cookie was presented, so none may be cleared: a late response must not
    // wipe the cookie of a session started in the meantime.
    expect(revoked.headers.get("set-cookie")).toBeNull();
  });

  // A bearer outranks a cookie for authentication, so a request carrying two
  // different sessions must not end one and merely blind the other.
  it("revokes both sessions when a bearer and a cookie name different ones", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const bearerSession = await provisional(app);
    const cookieSession = await provisional(app);

    const revoked = await app.request("/v1/principals/provisional/revoke", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerSession.accessToken}`,
        cookie: `os_provisional=${cookieSession.accessToken}`,
      },
    });
    expect(revoked.status).toBe(204);

    for (const token of [bearerSession.accessToken, cookieSession.accessToken]) {
      const after = await app.request("/v1/principals/me", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(after.status).toBe(401);
    }
  });

  it("creates temporary project and completes claim preserving ids", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };

    const projectRes = await app.request("/v1/projects/temporary", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "idempotency-key": "proj-1" },
      body: JSON.stringify({ name: "Temp Demo", ttlSeconds: 3600 }),
    });
    expect(projectRes.status).toBe(201);
    const project = (await projectRes.json()) as {
      projectId: string;
      claimId: string;
      claimToken: string;
      targetManifestDigest: string;
    };
    expect(project.projectId.startsWith("prj_")).toBe(true);
    expect(project.claimToken.startsWith("osc_clm_")).toBe(true);

    const bareGet = await app.request(`/v1/claims/${project.claimId}`);
    expect(bareGet.status).toBe(401);
    const barePoll = await app.request(`/v1/claims/${project.claimId}/poll`);
    expect(barePoll.status).toBe(401);
    const withToken = await app.request(`/v1/claims/${project.claimId}`, {
      headers: { "x-claim-token": project.claimToken },
    });
    expect(withToken.status).toBe(200);
    expect(((await withToken.json()) as { state: string }).state).toBe("pending");

    const present = await app.request("/v1/claims/present", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ token: project.claimToken }),
    });
    expect(present.status).toBe(200);
    // A reviewer accepts by id, so present must report the items. There is no
    // wildcard: "*" is looked up as a literal item id and refused.
    const presented = (await present.json()) as { items?: unknown[] };
    expect(Array.isArray(presented.items)).toBe(true);

    const wildcard = await app.request(`/v1/claims/${project.claimId}/complete`, {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "x-claim-token": project.claimToken,
      },
      body: JSON.stringify({ acceptedItemIds: ["*"] }),
    });
    expect(wildcard.status).toBeGreaterThanOrEqual(400);

    // A principal alone must not be enough: the claim id is public, so without
    // the claim bearer anyone signed in could take what someone else presented.
    const unbound = await app.request(`/v1/claims/${project.claimId}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ acceptedItemIds: [] }),
    });
    expect(unbound.status).toBe(401);

    const complete = await app.request(`/v1/claims/${project.claimId}/complete`, {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "x-claim-token": project.claimToken,
        "idempotency-key": "complete-1",
      },
      body: JSON.stringify({ acceptedItemIds: [] }),
    });
    expect(complete.status).toBe(200);
    const done = (await complete.json()) as {
      state: string;
      preserved: { principalId: string; projectId: string };
    };
    expect(done.state).toBe("completed");
    expect(done.preserved.principalId).toBe(created.principalId);
    expect(done.preserved.projectId).toBe(project.projectId);

    // A cached success answers before the handler runs, so replay is keyed to
    // the caller and the bearer it presented. Borrowing the key without the
    // claim token must not hand back someone else's completion.
    const borrowed = await app.request(
      `/v1/claims/${project.claimId}/complete`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": "complete-1",
        },
        body: JSON.stringify({ acceptedItemIds: [] }),
      },
    );
    expect(borrowed.status).toBe(401);
    expect(borrowed.headers.get("idempotency-replayed")).toBeNull();

    // The completer replaying with the same bearer still gets its own answer.
    const sameCaller = await app.request(
      `/v1/claims/${project.claimId}/complete`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "x-claim-token": project.claimToken,
          "idempotency-key": "complete-1",
        },
        body: JSON.stringify({ acceptedItemIds: [] }),
      },
    );
    expect(sameCaller.status).toBe(200);
    expect(sameCaller.headers.get("idempotency-replayed")).toBe("true");

    // Replay idempotency
    const replay = await app.request("/v1/projects/temporary", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "idempotency-key": "proj-1" },
      body: JSON.stringify({ name: "Temp Demo", ttlSeconds: 3600 }),
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    const replayBody = (await replay.json()) as { projectId: string };
    expect(replayBody.projectId).toBe(project.projectId);
  });

  it("serves discovery documents", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const authMd = await app.request("/auth.md");
    expect(authMd.status).toBe(200);
    expect(await authMd.text()).toContain("OpenSesame Auth");

    const card = await app.request("/.well-known/agent-card.json");
    expect(card.status).toBe(200);
    expect(((await card.json()) as { name: string }).name).toBe("OpenSesame");

    const prm = await app.request("/.well-known/oauth-protected-resource");
    expect(prm.status).toBe(200);
    expect(((await prm.json()) as { resource: string }).resource).toContain("8788");
  });

  it("pairwise subjects differ across sectors via oauth-provider", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const pairwise = createPairwiseIdentifierCallback(store);
    const a = await pairwise({}, "prn_same", {
      clientId: "rp-a",
      sectorIdentifier: "https://a.example",
    });
    const b = await pairwise({}, "prn_same", {
      clientId: "rp-b",
      sectorIdentifier: "https://b.example",
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe("prn_same");

    const { ctx } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    expect(ctx.oauth.env.issuer).toBe("http://127.0.0.1:8788");
    expect(ctx.oauth.configuration.subjectTypes).toContain("pairwise");
  });

  it("health endpoints", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788" },
    });
    expect((await app.request("/v1/health/live")).status).toBe(200);
    expect((await app.request("/v1/health/ready")).status).toBe(200);
  });

  it("escapes claim verify HTML and sets API security headers", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "https://id.example",
        issuer: "https://id.example",
      },
    });
    const live = await app.request("/v1/health/live");
    expect(live.headers.get("x-content-type-options")).toBe("nosniff");
    expect(live.headers.get("x-frame-options")).toBe("DENY");
    expect(live.headers.get("referrer-policy")).toBe("no-referrer");
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(live.headers.get("permissions-policy")).toContain("camera=()");
    expect(live.headers.get("strict-transport-security")).toContain("max-age=");

    const verify = await app.request(
      "/v1/claims/%3Cscript%3Ealert(1)%3C%2Fscript%3E/verify",
    );
    expect(verify.status).toBe(200);
    const html = await verify.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(verify.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    // Landing page must not disclose claim existence or state.
    for (const leak of ["pending", "completed", "denied", "expired", "unknown"]) {
      expect(html).not.toContain(leak);
    }
  });

  it("mfa passkey register/assert and totp enroll/verify", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };
    const reg = await app.request("/v1/mfa/passkey/register", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        credentialId: "cred_test_1",
        publicKey: Buffer.from("pk").toString("base64"),
        counter: 0,
      }),
    });
    expect(reg.status).toBe(200);

    const assertRes = await app.request("/v1/mfa/passkey/assert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credentialId: "cred_test_1",
        clientDataJSON: Buffer.from("{}").toString("base64"),
        authenticatorData: Buffer.from("a").toString("base64"),
        signature: Buffer.from("sig").toString("base64"),
      }),
    });
    expect(assertRes.status).toBe(200);
    expect(((await assertRes.json()) as { principalId: string }).principalId).toBe(
      created.principalId,
    );

    const enroll = await app.request("/v1/mfa/totp/enroll", {
      method: "POST",
      headers: auth,
    });
    expect(enroll.status).toBe(200);
    const { secret } = (await enroll.json()) as { secret: string };
    expect(secret).toBeTruthy();

    const { totpCode } = await import("../routes/mfa.js");
    const code = totpCode(secret);
    const verify = await app.request("/v1/mfa/totp/verify", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);
    expect(((await verify.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("production rejects stub TOTP enroll/verify", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        allowDevDefaults: false,
        claimPepper: "prod-claim-pepper-for-test-only",
        isProduction: false,
      },
      processEnv: {
        ...process.env,
        OPENSESAME_ALLOW_DEV_DEFAULTS: "false",
        OPENSESAME_CLAIM_PEPPER: "prod-claim-pepper-for-test-only",
        NODE_ENV: "development",
      },
    });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };
    const enroll = await app.request("/v1/mfa/totp/enroll", {
      method: "POST",
      headers: auth,
    });
    expect(enroll.status).toBe(403);
    expect(((await enroll.json()) as { error: string }).error).toBe("totp_dev_only");
    const verify = await app.request("/v1/mfa/totp/verify", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(verify.status).toBe(403);
  });

  it("production passkey register requires attestation ceremony", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        allowDevDefaults: false,
        claimPepper: "prod-claim-pepper-for-test-only",
        isProduction: false,
      },
      processEnv: {
        ...process.env,
        OPENSESAME_ALLOW_DEV_DEFAULTS: "false",
        OPENSESAME_CLAIM_PEPPER: "prod-claim-pepper-for-test-only",
        NODE_ENV: "development",
      },
    });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };

    const stubReg = await app.request("/v1/mfa/passkey/register", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        credentialId: "cred_prod_1",
        publicKey: Buffer.from("pk").toString("base64"),
      }),
    });
    expect(stubReg.status).toBe(400);
    expect(((await stubReg.json()) as { error: string }).error).toBe(
      "registration_attestation_required",
    );

    const opts = await app.request("/v1/mfa/passkey/registration-options", {
      method: "POST",
      headers: auth,
    });
    expect(opts.status).toBe(200);
    const { challenge } = (await opts.json()) as { challenge: string };
    expect(challenge.length).toBeGreaterThan(8);

    const badAttest = await app.request("/v1/mfa/passkey/register", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        response: {
          id: "cred_prod_1",
          rawId: "cred_prod_1",
          type: "public-key",
          response: {
            clientDataJSON: Buffer.from(
              JSON.stringify({
                type: "webauthn.create",
                challenge,
                origin: "http://127.0.0.1:8788",
              }),
            ).toString("base64url"),
            attestationObject: Buffer.from("not-real").toString("base64url"),
          },
          clientExtensionResults: {},
        },
      }),
    });
    expect(badAttest.status).toBe(401);
  });

  it("production passkey assert rejects without WebAuthn challenge binding", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        allowDevDefaults: false,
        claimPepper: "prod-claim-pepper-for-test-only",
        isProduction: false,
      },
      processEnv: {
        ...process.env,
        OPENSESAME_ALLOW_DEV_DEFAULTS: "false",
        OPENSESAME_CLAIM_PEPPER: "prod-claim-pepper-for-test-only",
        NODE_ENV: "development",
      },
    });
    const created = await provisional(app);
    const assertRes = await app.request("/v1/mfa/passkey/assert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credentialId: "cred_missing",
        clientDataJSON: Buffer.from(
          JSON.stringify({
            type: "webauthn.get",
            challenge: "not-issued",
            origin: "http://127.0.0.1:8788",
          }),
        ).toString("base64"),
        authenticatorData: Buffer.from("a").toString("base64"),
        signature: Buffer.from("sig").toString("base64"),
      }),
    });
    expect(assertRes.status).toBe(401);
    expect(created.principalId).toBeTruthy();
  });

  it("device approve requires authentication and never exposes operator token", async () => {
    const { app, config } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    expect(config.operatorToken).toBeTruthy();
    const unauth = await app.request("/v1/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_code: "ABCD-EFGH" }),
    });
    expect(unauth.status).toBe(401);
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };
    const res = await app.request("/v1/device/approve", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ user_code: "ABCD-EFGH" }),
    });
    // Host may be down in unit tests → 502, but never leak operator token in body.
    expect([200, 404, 502]).toContain(res.status);
    const body = await res.text();
    expect(body).not.toContain(config.operatorToken);
    expect(body.toLowerCase()).not.toContain("x-opensesame-operator");
  });

  it("links and lists identities without email auto-link; collision returns 409", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const a = await provisional(app);
    const b = await provisional(app);
    const authA = { authorization: `Bearer ${a.accessToken}` };
    const authB = { authorization: `Bearer ${b.accessToken}` };

    const linkA = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        ...authA,
        "content-type": "application/json",
        "idempotency-key": "link-a",
      },
      body: JSON.stringify({
        kind: "oidc",
        issuer: "https://mock.example",
        subject: "sub-shared-email-case",
        emailNormalized: "same@example.com",
        assurance: "verified",
      }),
    });
    expect(linkA.status).toBe(201);

    const list = await app.request("/v1/principals/identities", { headers: authA });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { identities: Array<{ subject: string }> };
    expect(listed.identities).toHaveLength(1);
    expect(listed.identities[0]?.subject).toBe("sub-shared-email-case");

    // Same email on a different subject must not auto-merge; linking a new subject succeeds.
    const linkBEmail = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        ...authB,
        "content-type": "application/json",
        "idempotency-key": "link-b-email",
      },
      body: JSON.stringify({
        kind: "oidc",
        issuer: "https://mock.example",
        subject: "sub-other",
        emailNormalized: "same@example.com",
        assurance: "verified",
      }),
    });
    expect(linkBEmail.status).toBe(201);

    // Same kind+issuer+subject cannot bind to a second principal.
    const collision = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        ...authB,
        "content-type": "application/json",
        "idempotency-key": "link-collision",
      },
      body: JSON.stringify({
        kind: "oidc",
        issuer: "https://mock.example",
        subject: "sub-shared-email-case",
        assurance: "verified",
      }),
    });
    expect(collision.status).toBe(409);
    expect(((await collision.json()) as { error: string }).error).toBe(
      "identity_collision",
    );

    const me = await app.request("/v1/principals/me", { headers: authA });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { id: string; assurance: string };
    expect(meBody.id).toBe(a.principalId);
    expect(meBody.assurance).not.toBe("provisional");
  });

  it("creates organization and oauth client; lists scoped audit events", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };

    await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "link-verified",
      },
      body: JSON.stringify({
        kind: "oidc",
        issuer: "https://mock.example",
        subject: "org-admin",
        assurance: "verified",
      }),
    });

    const orgRes = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "org-1",
      },
      body: JSON.stringify({ slug: "acme-labs", displayName: "Acme Labs" }),
    });
    expect(orgRes.status).toBe(201);
    const org = (await orgRes.json()) as { id: string; slug: string };
    expect(org.slug).toBe("acme-labs");

    const clientRes = await app.request("/v1/oauth/clients", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "cli-1",
      },
      body: JSON.stringify({
        displayName: "RP Alpha",
        redirectUris: ["http://127.0.0.1:5173/callback"],
        sectorIdentifier: "https://rp-alpha.example",
      }),
    });
    expect(clientRes.status).toBe(201);
    const client = (await clientRes.json()) as { id: string; admissionMode: string };
    expect(client.admissionMode).toBe("pre_registered");

    const audit = await app.request("/v1/audit/events?limit=20", { headers: auth });
    expect(audit.status).toBe(200);
    const events = (await audit.json()) as {
      events: Array<{ eventType: string; principalId?: string }>;
    };
    expect(events.events.length).toBeGreaterThan(0);
    expect(
      events.events.every(
        (e) => e.principalId === undefined || e.principalId === created.principalId,
      ),
    ).toBe(true);
    expect(events.events.some((e) => e.eventType === "organization.created")).toBe(
      true,
    );
  });

  it("lets the claim bearer header through the CORS preflight", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        corsOrigins: ["http://localhost:5173"],
      },
    });
    // Completing a claim carries its bearer in a custom header, so a preflight
    // that does not name it fails the whole ceremony from a browser.
    const res = await app.request("/v1/claims/clm_x/complete", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,x-claim-token",
      },
    });
    expect(
      res.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).toContain("x-claim-token");
  });

  it("keeps oauth clients private to the principal that registered them", async () => {
    const { app } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });

    const verified = async (subject: string, key: string) => {
      const session = await provisional(app);
      const auth = { authorization: `Bearer ${session.accessToken}` };
      await app.request("/v1/principals/link-identities", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          kind: "oidc",
          issuer: "https://mock.example",
          subject,
          assurance: "verified",
        }),
      });
      return auth;
    };

    const owner = await verified("client-owner", "link-owner");
    const stranger = await verified("client-stranger", "link-stranger");

    const created = await app.request("/v1/oauth/clients", {
      method: "POST",
      headers: { ...owner, "content-type": "application/json", "idempotency-key": "cli-owned" },
      body: JSON.stringify({
        displayName: "RP Owned",
        redirectUris: ["http://127.0.0.1:5173/callback"],
        sectorIdentifier: "https://rp-owned.example",
      }),
    });
    expect(created.status).toBe(201);
    const client = (await created.json()) as { id: string };

    const ownerList = await app.request("/v1/oauth/clients", { headers: owner });
    const owned = (await ownerList.json()) as { clients: Array<{ id: string }> };
    expect(owned.clients.map((c) => c.id)).toContain(client.id);

    // Another principal must not see it, and must not be able to point its
    // redirect somewhere of their choosing — that would be account takeover for
    // every site signing in through it.
    const strangerList = await app.request("/v1/oauth/clients", { headers: stranger });
    const seen = (await strangerList.json()) as { clients: Array<{ id: string }> };
    expect(seen.clients.map((c) => c.id)).not.toContain(client.id);

    const hijack = await app.request(`/v1/oauth/clients/${client.id}`, {
      method: "PATCH",
      headers: { ...stranger, "content-type": "application/json" },
      body: JSON.stringify({ redirectUris: ["https://attacker.example/cb"] }),
    });
    expect(hijack.status).toBe(404);

    for (const path of ["rotate", "revoke"]) {
      const res = await app.request(`/v1/oauth/clients/${client.id}/${path}`, {
        method: "POST",
        headers: stranger,
      });
      expect(res.status).toBe(404);
    }

    const patch = await app.request(`/v1/oauth/clients/${client.id}`, {
      method: "PATCH",
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "RP Renamed" }),
    });
    expect(patch.status).toBe(200);
  });

  it("rejects provisional create when session capacity is exhausted", async () => {
    const { app, ctx } = createControlPlane({
      config: { port: 0, publicUrl: "http://127.0.0.1:8788", issuer: "http://127.0.0.1:8788" },
    });
    const far = new Date(Date.now() + 86_400_000);
    for (let i = 0; i < 1024; i++) {
      const id = `ps_cap_${i}`;
      ctx.stores.provisionalSessions.set(id, {
        id,
        principalId: `prn_cap_${i}`,
        createdAt: new Date(),
        expiresAt: far,
        quotaProfile: "anonymous",
        allowedActions: [],
      });
    }
    const res = await app.request("/v1/principals/provisional", { method: "POST" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("provisional_capacity");
  });

  it("HTTP mount does not steal /auth.md from oidc /auth prefix", async () => {
    const { startServer } = await import("../server.js");
    const { server, port } = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        publicUrl: "http://127.0.0.1:0",
        issuer: "http://127.0.0.1:0",
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/auth.md`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("OpenSesame Auth");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
