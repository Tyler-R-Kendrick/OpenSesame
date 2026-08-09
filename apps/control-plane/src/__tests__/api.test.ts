import {
  MemoryPairwiseSubjectStore,
  createPairwiseIdentifierCallback,
} from "@opensesame/oauth-provider";
import {
  DEFAULT_PROVISIONAL_QUOTA,
  DEFAULT_VERIFIED_QUOTA,
  ProvisionalPolicy,
} from "@opensesame/policy";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

async function provisional(app: ReturnType<typeof createControlPlane>["app"]) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
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
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
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

  it("rejects provisional session id as Bearer or cookie credential", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
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

  it("does not activate a project whose TTL ran out before the claim completed", async () => {
    const now = new Date("2026-08-08T12:00:00Z");
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
      clock: () => now,
    });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };

    const projectRes = await app.request("/v1/projects/temporary", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "Short Lived", ttlSeconds: 600 }),
    });
    const project = (await projectRes.json()) as {
      projectId: string;
      claimId: string;
      claimToken: string;
      userCode: string;
    };

    await app.request("/v1/claims/present", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ token: project.claimToken }),
    });

    // Today the claim never outlives the project, so force the case directly:
    // approval must not resurrect a project that is already past its own TTL.
    const stored = ctx.stores.projects.get(project.projectId)!;
    ctx.stores.projects.set(project.projectId, {
      ...stored,
      expiresAt: new Date(now.getTime() - 1_000),
    });

    const complete = await app.request(
      `/v1/claims/${project.claimId}/complete`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          acceptedItemIds: [],
          userCode: project.userCode,
        }),
      },
    );
    expect(complete.status).toBe(200);
    expect(ctx.stores.projects.get(project.projectId)?.state).toBe("expired");
  });

  it("frees a provisional quota slot when a temporary project lapses", async () => {
    let now = new Date("2026-08-08T10:00:00Z");
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
      clock: () => now,
    });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };

    const create = async (name: string) =>
      app.request("/v1/projects/temporary", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ name, ttlSeconds: 60 }),
      });

    for (const name of ["one", "two", "three"]) {
      expect((await create(name)).status).toBe(201);
    }
    // Quota of three is spent.
    const overQuota = await create("four");
    expect(overQuota.status).toBe(403);
    expect(
      ((await overQuota.json()) as { reasons: string[] }).reasons,
    ).toContain("provisional_quota_projects");

    // Once they lapse the slots come back: the cap is live, not lifetime.
    now = new Date(now.getTime() + 120_000);
    expect(ctx.stores.projects.size).toBe(3);
    expect((await create("five")).status).toBe(201);
  });

  it("creates temporary project and completes claim preserving ids", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };

    const projectRes = await app.request("/v1/projects/temporary", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "proj-1",
      },
      body: JSON.stringify({ name: "Temp Demo", ttlSeconds: 3600 }),
    });
    expect(projectRes.status).toBe(201);
    const project = (await projectRes.json()) as {
      projectId: string;
      claimId: string;
      claimToken: string;
      userCode: string;
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
    expect(((await withToken.json()) as { state: string }).state).toBe(
      "pending",
    );

    const present = await app.request("/v1/claims/present", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ token: project.claimToken }),
    });
    expect(present.status).toBe(200);

    // Approval without the device's user code is not consent.
    const noCode = await app.request(`/v1/claims/${project.claimId}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ acceptedItemIds: [], userCode: "0000-0000" }),
    });
    expect(noCode.status).toBe(401);

    const complete = await app.request(
      `/v1/claims/${project.claimId}/complete`,
      {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": "complete-1",
        },
        body: JSON.stringify({
          acceptedItemIds: [],
          userCode: project.userCode,
        }),
      },
    );
    expect(complete.status).toBe(200);
    const done = (await complete.json()) as {
      state: string;
      preserved: { principalId: string; projectId: string };
    };
    expect(done.state).toBe("completed");
    expect(done.preserved.principalId).toBe(created.principalId);
    expect(done.preserved.projectId).toBe(project.projectId);

    // Replay idempotency
    const replay = await app.request("/v1/projects/temporary", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "proj-1",
      },
      body: JSON.stringify({ name: "Temp Demo", ttlSeconds: 3600 }),
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    const replayBody = (await replay.json()) as { projectId: string };
    expect(replayBody.projectId).toBe(project.projectId);
  });

  it("serves discovery documents", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const authMd = await app.request("/auth.md");
    expect(authMd.status).toBe(200);
    expect(await authMd.text()).toContain("OpenSesame Auth");

    const card = await app.request("/.well-known/agent-card.json");
    expect(card.status).toBe(200);
    expect(((await card.json()) as { name: string }).name).toBe("OpenSesame");

    const prm = await app.request("/.well-known/oauth-protected-resource");
    expect(prm.status).toBe(200);
    expect(((await prm.json()) as { resource: string }).resource).toContain(
      "8788",
    );
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
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
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
    for (const leak of [
      "pending",
      "completed",
      "denied",
      "expired",
      "unknown",
    ]) {
      expect(html).not.toContain(leak);
    }
  });

  it("mfa passkey register/assert and totp enroll/verify", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
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
    expect(
      ((await assertRes.json()) as { principalId: string }).principalId,
    ).toBe(created.principalId);

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

  it("fences wrong TOTP codes after five tries", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };
    const enroll = await app.request("/v1/mfa/totp/enroll", {
      method: "POST",
      headers: auth,
    });
    const { secret } = (await enroll.json()) as { secret: string };

    const attempt = (code: string) =>
      app.request("/v1/mfa/totp/verify", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt("000000")).status).toBe(401);
    }
    // Six digits is a million guesses; the fence closes before that.
    expect((await attempt("000000")).status).toBe(429);

    const { totpCode } = await import("../routes/mfa.js");
    // Even the right code is refused while the fence is closed.
    expect((await attempt(totpCode(secret))).status).toBe(429);

    // The refusals are in the trail. A trail of successes only would read as one
    // ordinary login rather than as six guesses against a six-digit code.
    const audit = await app.request("/v1/audit/events?limit=50", {
      headers: auth,
    });
    const events = (await audit.json()) as {
      events: Array<{
        eventType: string;
        outcome: string;
        metadata: { reason?: string };
      }>;
    };
    const denials = events.events.filter(
      (e) => e.eventType === "mfa.totp.verify" && e.outcome === "denied",
    );
    expect(denials.length).toBeGreaterThanOrEqual(6);
    expect(denials.map((e) => e.metadata.reason)).toContain("bad_code");
    expect(denials.map((e) => e.metadata.reason)).toContain(
      "too_many_attempts",
    );
  });

  it("fences repeated failing passkey assertions per credential", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const attempt = () =>
      app.request("/v1/mfa/passkey/assert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialId: "cred_unknown",
          clientDataJSON: Buffer.from("{}").toString("base64"),
          authenticatorData: Buffer.from("a").toString("base64"),
          signature: Buffer.from("sig").toString("base64"),
        }),
      });
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(401);
    }
    expect((await attempt()).status).toBe(429);
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
    expect(((await enroll.json()) as { error: string }).error).toBe(
      "totp_dev_only",
    );
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
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
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
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
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

    const list = await app.request("/v1/principals/identities", {
      headers: authA,
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      identities: Array<{ subject: string }>;
    };
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
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
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
    const client = (await clientRes.json()) as {
      id: string;
      admissionMode: string;
    };
    expect(client.admissionMode).toBe("pre_registered");

    const audit = await app.request("/v1/audit/events?limit=20", {
      headers: auth,
    });
    expect(audit.status).toBe(200);
    const events = (await audit.json()) as {
      events: Array<{ eventType: string; principalId?: string }>;
    };
    expect(events.events.length).toBeGreaterThan(0);
    expect(
      events.events.every(
        (e) =>
          e.principalId === undefined || e.principalId === created.principalId,
      ),
    ).toBe(true);
    expect(
      events.events.some((e) => e.eventType === "organization.created"),
    ).toBe(true);

    // Every event carries the digest of the one before it, and the trail says so.
    const chained = (await (
      await app.request("/v1/audit/events?limit=20", { headers: auth })
    ).json()) as {
      events: Array<{ digest?: string; previousDigest?: string }>;
    };
    expect(chained.events.every((e) => e.digest && e.previousDigest)).toBe(
      true,
    );
    const verify = await app.request("/v1/audit/events/verify", {
      headers: auth,
    });
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({ ok: true });
  });

  it("holds a verified principal to an organization and client quota", async () => {
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    // A small allowance so the fence is reached in a couple of requests.
    ctx.policy = new ProvisionalPolicy(DEFAULT_PROVISIONAL_QUOTA, {
      ...DEFAULT_VERIFIED_QUOTA,
      maxOrganizations: 1,
      maxOAuthClients: 1,
    });

    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };
    await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "idempotency-key": "link-q",
      },
      body: JSON.stringify({
        kind: "oidc",
        issuer: "https://mock.example",
        subject: "quota-admin",
        assurance: "verified",
      }),
    });

    const createOrg = (slug: string, key: string) =>
      app.request("/v1/organizations", {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ slug, displayName: slug }),
      });
    expect((await createOrg("quota-one", "q-org-1")).status).toBe(201);
    const secondOrg = await createOrg("quota-two", "q-org-2");
    expect(secondOrg.status).toBe(403);
    expect(
      ((await secondOrg.json()) as { reasons: string[] }).reasons,
    ).toContain("quota_organizations");

    const createClient = (name: string, key: string) =>
      app.request("/v1/oauth/clients", {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({
          displayName: name,
          redirectUris: ["https://rp.example/callback"],
          sectorIdentifier: "https://rp.example",
        }),
      });
    const firstClient = await createClient("RP One", "q-cli-1");
    expect(firstClient.status).toBe(201);
    const clientId = ((await firstClient.json()) as { id: string }).id;
    const secondClient = await createClient("RP Two", "q-cli-2");
    expect(secondClient.status).toBe(403);
    expect(
      ((await secondClient.json()) as { reasons: string[] }).reasons,
    ).toContain("quota_oauth_clients");

    // Revoking frees the slot: a quota counted from the store is a live limit,
    // not a lifetime cap.
    const revoked = await app.request(`/v1/oauth/clients/${clientId}/revoke`, {
      method: "POST",
      headers: auth,
    });
    expect(revoked.status).toBe(200);
    expect((await createClient("RP Three", "q-cli-3")).status).toBe(201);
  });

  it("does not let a second principal claim a sector identifier", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });

    async function verified(subject: string) {
      const created = await provisional(app);
      const auth = { authorization: `Bearer ${created.accessToken}` };
      await app.request("/v1/principals/link-identities", {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": subject,
        },
        body: JSON.stringify({
          kind: "oidc",
          issuer: "https://mock.example",
          subject,
          assurance: "verified",
        }),
      });
      return auth;
    }

    const register = (
      auth: Record<string, string>,
      key: string,
      sectorIdentifier: string,
    ) =>
      app.request("/v1/oauth/clients", {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({
          displayName: "RP",
          redirectUris: ["https://rp.example/cb"],
          sectorIdentifier,
        }),
      });

    const owner = await verified("sector-owner");
    const intruder = await verified("sector-intruder");
    expect((await register(owner, "sec-1", "https://rp.example")).status).toBe(
      201,
    );
    // Same sector, same owner: a legitimate choice, two clients that mean to share
    // one subject.
    expect((await register(owner, "sec-2", "https://rp.example")).status).toBe(
      201,
    );

    // Another principal taking the sector would see the very subject the owner's
    // clients see for the same person, which is the linkage pairwise prevents.
    const taken = await register(intruder, "sec-3", "https://rp.example");
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: string }).error).toBe(
      "sector_identifier_taken",
    );
    expect(
      (await register(intruder, "sec-4", "https://other.example")).status,
    ).toBe(201);
  });

  it("fences oauth clients to their owning principal", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });

    async function verifiedPrincipal(subject: string) {
      const created = await provisional(app);
      const auth = { authorization: `Bearer ${created.accessToken}` };
      const linked = await app.request("/v1/principals/link-identities", {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "idempotency-key": subject,
        },
        body: JSON.stringify({
          kind: "oidc",
          issuer: "https://mock.example",
          subject,
          assurance: "verified",
        }),
      });
      expect(linked.status).toBe(201);
      return { ...created, auth };
    }

    const owner = await verifiedPrincipal("client-owner");
    const other = await verifiedPrincipal("client-intruder");

    const createRes = await app.request("/v1/oauth/clients", {
      method: "POST",
      headers: {
        ...owner.auth,
        "content-type": "application/json",
        "idempotency-key": "cli-owned",
      },
      body: JSON.stringify({
        displayName: "RP Owned",
        redirectUris: ["https://rp.example.test/cb"],
        sectorIdentifier: "https://rp.example.test",
      }),
    });
    expect(createRes.status).toBe(201);
    const client = (await createRes.json()) as {
      id: string;
      ownerPrincipalId: string;
    };
    expect(client.ownerPrincipalId).toBe(owner.principalId);

    // A different principal cannot see it…
    const otherList = await app.request("/v1/oauth/clients", {
      headers: other.auth,
    });
    expect(
      ((await otherList.json()) as { clients: unknown[] }).clients,
    ).toEqual([]);

    // …nor repoint its redirect URIs, rotate it, or revoke it.
    const hijack = await app.request(`/v1/oauth/clients/${client.id}`, {
      method: "PATCH",
      headers: { ...other.auth, "content-type": "application/json" },
      body: JSON.stringify({ redirectUris: ["https://attacker.test/cb"] }),
    });
    expect(hijack.status).toBe(404);
    for (const action of ["rotate", "revoke"]) {
      const res = await app.request(
        `/v1/oauth/clients/${client.id}/${action}`,
        {
          method: "POST",
          headers: other.auth,
        },
      );
      expect(res.status).toBe(404);
    }

    // The owner still can, and a javascript: redirect URI is refused outright.
    const patched = await app.request(`/v1/oauth/clients/${client.id}`, {
      method: "PATCH",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "RP Renamed" }),
    });
    expect(patched.status).toBe(200);
    const badUri = await app.request(`/v1/oauth/clients/${client.id}`, {
      method: "PATCH",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ redirectUris: ["javascript:alert(1)"] }),
    });
    expect(badUri.status).toBe(400);
  });

  it("refuses self-asserted identity links outside dev and hides the bound principal", async () => {
    const prod = createControlPlane({
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
    const created = await provisional(prod.app);
    const escalate = await prod.app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": "link-prod",
      },
      body: JSON.stringify({
        kind: "oidc",
        issuer: "https://accounts.example",
        subject: "victim",
        assurance: "verified",
      }),
    });
    expect(escalate.status).toBe(403);
    expect(((await escalate.json()) as { error: string }).error).toBe(
      "identity_link_requires_upstream",
    );
    // The principal must not have been promoted.
    const me = await prod.app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(((await me.json()) as { assurance: string }).assurance).toBe(
      "provisional",
    );

    // In dev the link works, but a collision never reveals the bound principal.
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const a = await provisional(app);
    const b = await provisional(app);
    const identity = {
      kind: "oidc",
      issuer: "https://accounts.example",
      subject: "shared-subject",
      assurance: "verified",
    };
    const first = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${a.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": "link-first",
      },
      body: JSON.stringify(identity),
    });
    expect(first.status).toBe(201);
    const collision = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${b.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": "link-collide",
      },
      body: JSON.stringify(identity),
    });
    expect(collision.status).toBe(409);
    const body = await collision.text();
    expect(body).toContain("identity_collision");
    expect(body).not.toContain(a.principalId);
  });

  it("rejects provisional create when session capacity is exhausted", async () => {
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
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
    const res = await app.request("/v1/principals/provisional", {
      method: "POST",
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("provisional_capacity");
  });

  it("never replays another principal's idempotent response", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });

    const victim = await provisional(app);
    const attacker = await provisional(app);
    const sharedKey = "signup-1";

    const register = (token: string) =>
      app.request("/v1/agents", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": sharedKey,
        },
        body: JSON.stringify({
          displayName: "worker",
          publicKeyJkt: "jkt_abcdefgh",
        }),
      });

    const first = await register(victim.accessToken);
    expect(first.status).toBe(201);
    const mine = (await first.json()) as {
      agentId: string;
      claimToken: string;
    };

    // Same key, different caller: must not hand over the victim's claim token.
    const second = await register(attacker.accessToken);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotency-replayed")).toBeNull();
    const theirs = (await second.json()) as {
      agentId: string;
      claimToken: string;
    };
    expect(theirs.agentId).not.toBe(mine.agentId);
    expect(theirs.claimToken).not.toBe(mine.claimToken);

    // The owner still gets a replay for their own key.
    const replay = await register(victim.accessToken);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(((await replay.json()) as { agentId: string }).agentId).toBe(
      mine.agentId,
    );
  });

  it("does not replay unauthenticated provisional signups across callers", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });

    const signup = () =>
      app.request("/v1/principals/provisional", {
        method: "POST",
        headers: { "idempotency-key": "shared" },
      });

    const a = await signup();
    const b = await signup();
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotency-replayed")).toBeNull();
    const first = (await a.json()) as {
      accessToken: string;
      principalId: string;
    };
    const second = (await b.json()) as {
      accessToken: string;
      principalId: string;
    };
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.principalId).not.toBe(first.principalId);
  });

  it("fences agent claim ceremonies to the registering principal", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });

    const owner = await provisional(app);
    const intruder = await provisional(app);

    const registered = await app.request("/v1/agents", {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": "agent-owned",
      },
      body: JSON.stringify({
        displayName: "worker",
        publicKeyJkt: "jkt_abcdefgh",
      }),
    });
    expect(registered.status).toBe(201);
    const { agentId } = (await registered.json()) as { agentId: string };

    // A foreign caller may not start a claim that would name them owner.
    const stolen = await app.request(`/v1/agents/${agentId}/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${intruder.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": "agent-steal",
      },
      body: JSON.stringify({}),
    });
    expect(stolen.status).toBe(404);

    const mine = await app.request(`/v1/agents/${agentId}/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
        "idempotency-key": "agent-own-claim",
      },
      body: JSON.stringify({}),
    });
    expect(mine.status).toBe(201);
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
