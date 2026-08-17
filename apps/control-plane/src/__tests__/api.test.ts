import {
  MemoryPairwiseSubjectStore,
  createPairwiseIdentifierCallback,
} from "@opensesame/oauth-provider";
import {
  DEFAULT_PROVISIONAL_QUOTA,
  DEFAULT_VERIFIED_QUOTA,
  ProvisionalPolicy,
} from "@opensesame/policy";
import { describe, expect, it, vi } from "vitest";
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

async function verifiedPrincipal(
  app: ReturnType<typeof createControlPlane>["app"],
  subject: string,
) {
  const created = await provisional(app);
  const auth = { authorization: `Bearer ${created.accessToken}` };
  const linked = await app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "idempotency-key": `verify-${subject}`,
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

  it("seeds one owner workspace only when the local stack opts in", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        bootstrapPersonalOrganization: true,
      },
    });
    const created = await provisional(app);
    const organizations = await app.request("/v1/organizations", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(organizations.status).toBe(200);
    expect(await organizations.json()).toMatchObject({
      organizations: [
        { displayName: "Personal workspace", role: "owner", state: "active" },
      ],
    });
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
    const stored = ctx.stores.projects.get(project.projectId);
    expect(stored).toBeDefined();
    if (!stored) throw new Error("project missing from store");
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
    // Authentication reaches the handler, which requires organization selection.
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(config.operatorToken);
    expect(body.toLowerCase()).not.toContain("x-opensesame-operator");
  });

  it("does not let an ambient cookie approve a device from another origin", async () => {
    const { app, config } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        corsOrigins: ["https://console.example"],
      },
    });
    const created = await provisional(app);
    const cookie = `${config.provisionalCookieName}=${created.accessToken}`;
    const approve = (headers: Record<string, string>) =>
      app.request("/v1/device/approve", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...headers },
        body: JSON.stringify({ user_code: "ABCD-EFGH" }),
      });

    // A cookie arrives whether or not the page meant to send it.
    expect((await approve({})).status).toBe(401);
    expect((await approve({ origin: "https://evil.example" })).status).toBe(
      401,
    );
    // An origin this deployment listed, or its own, is a caller it expects.
    expect((await approve({ origin: "https://console.example" })).status).toBe(
      400,
    );
    expect((await approve({ origin: "http://127.0.0.1:8788" })).status).toBe(
      400,
    );
    // Reads are untouched: a forged read is not a forged write.
    const read = await app.request("/v1/audit/events", {
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(read.status).toBe(200);
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
    const { app, ctx } = createControlPlane({
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

    // The walk covers the contiguous run, not the caller's slice. That is what
    // makes a removed event detectable: one principal's events are not adjacent in
    // the trail, so a slice can only ever show `altered`. There is no repository
    // method that deletes an audit event, so the removal case itself is covered by
    // the unit tests in `packages/audit`.
    await ctx.repos.auditEvents.append({
      id: "evt_someone_else",
      occurredAt: new Date(),
      eventType: "organization.created",
      outcome: "succeeded",
      correlationId: "cor_someone_else",
      principalId: "prn_someone_else",
      metadata: {},
    });
    const everything = await ctx.repos.auditEvents.list({ limit: 200 });
    const mine = await ctx.repos.auditEvents.list({
      principalId: created.principalId,
      limit: 200,
    });
    expect(everything.length).toBeGreaterThan(mine.length);

    const verified = (await (
      await app.request("/v1/audit/events/verify", { headers: auth })
    ).json()) as { ok: boolean; checked: number; eventId?: string };
    expect(verified.ok).toBe(true);
    expect(verified.checked).toBe(everything.length);
  });

  it("enforces organization membership roles and protects the last owner", async () => {
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const owner = await verifiedPrincipal(app, "membership-owner");
    const member = await verifiedPrincipal(app, "membership-member");
    const candidate = await verifiedPrincipal(app, "membership-candidate");
    const inactive = await verifiedPrincipal(app, "membership-inactive");
    const inactiveRecord = await ctx.repos.principals.getById(
      inactive.principalId,
    );
    expect(inactiveRecord).not.toBeNull();
    if (!inactiveRecord) throw new Error("principal missing from repository");
    await ctx.repos.principals.update(
      inactive.principalId,
      { state: "suspended", suspendedAt: new Date(), updatedAt: new Date() },
      inactiveRecord.version,
    );

    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...owner.auth,
        "content-type": "application/json",
        "idempotency-key": "membership-org",
      },
      body: JSON.stringify({
        slug: "membership-org",
        displayName: "Membership Org",
      }),
    });
    expect(created.status).toBe(201);
    const organization = (await created.json()) as {
      id: string;
      role: string;
    };
    expect(organization.role).toBe("owner");

    const add = (principalId: string, role: string, auth = owner.auth) =>
      app.request(`/v1/organizations/${organization.id}/members`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ principalId, role }),
      });
    expect((await add(member.principalId, "member")).status).toBe(201);
    expect((await add(member.principalId, "admin")).status).toBe(409);
    expect((await add("prn_missing", "member")).status).toBe(404);
    const inactiveAdd = await add(inactive.principalId, "member");
    expect(inactiveAdd.status).toBe(409);
    expect((await inactiveAdd.json()) as { error: string }).toEqual({
      error: "principal_inactive",
    });

    const memberOrganizations = await app.request("/v1/organizations", {
      headers: member.auth,
    });
    expect(memberOrganizations.status).toBe(200);
    expect(
      (
        (await memberOrganizations.json()) as {
          organizations: Array<{ id: string; role: string }>;
        }
      ).organizations,
    ).toContainEqual(
      expect.objectContaining({ id: organization.id, role: "member" }),
    );
    expect(
      (
        (await (
          await app.request(`/v1/organizations/${organization.id}`, {
            headers: member.auth,
          })
        ).json()) as { role: string }
      ).role,
    ).toBe("member");
    expect(
      (
        await app.request(`/v1/organizations/${organization.id}/members`, {
          headers: member.auth,
        })
      ).status,
    ).toBe(403);
    expect(
      (await add(candidate.principalId, "member", member.auth)).status,
    ).toBe(403);

    const demoteLastOwner = await app.request(
      `/v1/organizations/${organization.id}/members/${owner.principalId}`,
      {
        method: "PATCH",
        headers: { ...owner.auth, "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      },
    );
    expect(demoteLastOwner.status).toBe(409);
    const removeLastOwner = await app.request(
      `/v1/organizations/${organization.id}/members/${owner.principalId}`,
      { method: "DELETE", headers: owner.auth },
    );
    expect(removeLastOwner.status).toBe(409);
  });

  it("derives device organization role and revokes Host sessions on membership changes", async () => {
    const { app, ctx } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        hostApiUrl: "https://host.example/tenant",
      },
    });
    const owner = await verifiedPrincipal(app, "device-owner");
    const member = await verifiedPrincipal(app, "device-member");
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...owner.auth,
        "content-type": "application/json",
        "idempotency-key": "device-org",
      },
      body: JSON.stringify({ slug: "device-org", displayName: "Device Org" }),
    });
    const organization = (await created.json()) as { id: string };
    expect(organization.id).toMatch(
      /^org:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await app.request(`/v1/organizations/${organization.id}/members`, {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });

    const requests: Array<{ url: string; body: Record<string, string> }> = [];
    const rolesSeenByHost: Array<string | undefined> = [];
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const host = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          body: JSON.parse(String(init?.body)) as Record<string, string>,
        });
        if (url.endsWith("/api/v1/sessions/revoke")) {
          rolesSeenByHost.push(
            ctx.stores.organizationMemberships.get(
              `${organization.id}:${member.principalId}`,
            )?.role,
          );
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    try {
      const approval = await app.request("/v1/device/approve", {
        method: "POST",
        headers: { ...member.auth, "content-type": "application/json" },
        body: JSON.stringify({
          user_code: "ABCD-EFGH",
          organization_id: organization.id,
          organization_role: "owner",
          principal: owner.principalId,
        }),
      });
      expect(approval.status).toBe(200);
      expect(requests[0]?.body).toMatchObject({
        principal: member.principalId,
        organization_id: organization.id,
        organization_role: "member",
      });

      host.mockResolvedValueOnce(new Response("down", { status: 503 }));
      const failedChange = await app.request(
        `/v1/organizations/${organization.id}/members/${member.principalId}`,
        {
          method: "PATCH",
          headers: { ...owner.auth, "content-type": "application/json" },
          body: JSON.stringify({ role: "admin" }),
        },
      );
      expect(failedChange.status).toBe(502);
      expect(
        (
          (await (
            await app.request(`/v1/organizations/${organization.id}`, {
              headers: member.auth,
            })
          ).json()) as { role: string }
        ).role,
      ).toBe("member");

      const changed = await app.request(
        `/v1/organizations/${organization.id}/members/${member.principalId}`,
        {
          method: "PATCH",
          headers: { ...owner.auth, "content-type": "application/json" },
          body: JSON.stringify({ role: "admin" }),
        },
      );
      expect(changed.status).toBe(200);
      expect((await changed.json()) as { role: string }).toEqual(
        expect.objectContaining({ role: "admin" }),
      );
      const removed = await app.request(
        `/v1/organizations/${organization.id}/members/${member.principalId}`,
        { method: "DELETE", headers: owner.auth },
      );
      expect(removed.status).toBe(204);
      expect(
        requests.filter((request) =>
          request.url.endsWith("/api/v1/sessions/revoke"),
        ),
      ).toHaveLength(2);
      expect(host).toHaveBeenCalledTimes(4);
      expect(rolesSeenByHost).toEqual(["admin", undefined]);
      expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
        "/tenant/api/v1/device/approve",
        "/tenant/api/v1/sessions/revoke",
        "/tenant/api/v1/sessions/revoke",
      ]);
      expect(timeout).toHaveBeenCalledTimes(4);
      for (const call of timeout.mock.calls) expect(call).toEqual([5_000]);
    } finally {
      timeout.mockRestore();
      host.mockRestore();
    }
  });

  it("rejects malformed device approval fields without throwing", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const principal = await provisional(app);
    const request = (body: string) =>
      app.request("/v1/device/approve", {
        method: "POST",
        headers: {
          authorization: `Bearer ${principal.accessToken}`,
          "content-type": "application/json",
        },
        body,
      });

    expect((await request(JSON.stringify({ user_code: 7 }))).status).toBe(400);
    expect(
      (
        await request(
          JSON.stringify({ user_code: "ABCD-EFGH", organization_id: 7 }),
        )
      ).status,
    ).toBe(400);
    expect((await request("{")).status).toBe(400);
  });

  it("serializes membership rollback so it cannot resurrect a removed owner", async () => {
    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
      },
    });
    const owner = await verifiedPrincipal(app, "serialized-owner");
    const target = await verifiedPrincipal(app, "serialized-target");
    const created = await app.request("/v1/organizations", {
      method: "POST",
      headers: {
        ...owner.auth,
        "content-type": "application/json",
        "idempotency-key": "serialized-org",
      },
      body: JSON.stringify({
        slug: "serialized-org",
        displayName: "Serialized Org",
      }),
    });
    const organization = (await created.json()) as { id: string };
    await app.request(`/v1/organizations/${organization.id}/members`, {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ principalId: target.principalId, role: "owner" }),
    });

    let markFirstStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst = (_response: Response) => {};
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    let markSecondStarted = () => {};
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const host = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        markFirstStarted();
        return firstResponse;
      })
      .mockImplementation(async () => {
        markSecondStarted();
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    try {
      const failedDemotion = app.request(
        `/v1/organizations/${organization.id}/members/${target.principalId}`,
        {
          method: "PATCH",
          headers: { ...owner.auth, "content-type": "application/json" },
          body: JSON.stringify({ role: "admin" }),
        },
      );
      await firstStarted;
      const removal = app.request(
        `/v1/organizations/${organization.id}/members/${target.principalId}`,
        { method: "DELETE", headers: owner.auth },
      );
      expect(
        await Promise.race([
          secondStarted.then(() => "reached-host"),
          new Promise<string>((resolve) =>
            setImmediate(() => resolve("blocked-at-fence")),
          ),
        ]),
      ).toBe("blocked-at-fence");

      releaseFirst(new Response("down", { status: 503 }));
      expect((await failedDemotion).status).toBe(502);
      expect((await removal).status).toBe(204);
      await secondStarted;

      const members = (await (
        await app.request(`/v1/organizations/${organization.id}/members`, {
          headers: owner.auth,
        })
      ).json()) as { members: Array<{ principalId: string }> };
      expect(members.members).not.toContainEqual(
        expect.objectContaining({ principalId: target.principalId }),
      );
    } finally {
      host.mockRestore();
    }
  });

  it.each(["PATCH", "DELETE"] as const)(
    "orders a paused device approval before a concurrent %s membership mutation",
    async (method) => {
      const { app } = createControlPlane({
        config: {
          port: 0,
          publicUrl: "http://127.0.0.1:8788",
          issuer: "http://127.0.0.1:8788",
        },
      });
      const owner = await verifiedPrincipal(
        app,
        `approval-race-owner-${method}`,
      );
      const target = await verifiedPrincipal(
        app,
        `approval-race-target-${method}`,
      );
      const created = await app.request("/v1/organizations", {
        method: "POST",
        headers: {
          ...owner.auth,
          "content-type": "application/json",
          "idempotency-key": `approval-race-org-${method}`,
        },
        body: JSON.stringify({
          slug: `approval-race-${method.toLowerCase()}`,
          displayName: "Approval Race",
        }),
      });
      const organization = (await created.json()) as { id: string };
      expect(
        (
          await app.request(`/v1/organizations/${organization.id}/members`, {
            method: "POST",
            headers: { ...owner.auth, "content-type": "application/json" },
            body: JSON.stringify({
              principalId: target.principalId,
              role: "owner",
            }),
          })
        ).status,
      ).toBe(201);

      let markApprovalStarted = () => {};
      const approvalStarted = new Promise<void>((resolve) => {
        markApprovalStarted = resolve;
      });
      let releaseApproval = (_response: Response) => {};
      const approvalResponse = new Promise<Response>((resolve) => {
        releaseApproval = resolve;
      });
      let markMutationReachedHost = () => {};
      const mutationReachedHost = new Promise<void>((resolve) => {
        markMutationReachedHost = resolve;
      });
      const hostUrls: string[] = [];
      const host = vi
        .spyOn(globalThis, "fetch")
        .mockImplementationOnce(async (input) => {
          hostUrls.push(String(input));
          markApprovalStarted();
          return approvalResponse;
        })
        .mockImplementation(async (input) => {
          hostUrls.push(String(input));
          markMutationReachedHost();
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        });
      try {
        const approval = app.request("/v1/device/approve", {
          method: "POST",
          headers: { ...target.auth, "content-type": "application/json" },
          body: JSON.stringify({
            user_code: "ABCD-EFGH",
            organization_id: organization.id,
          }),
        });
        await approvalStarted;

        const mutation = app.request(
          `/v1/organizations/${organization.id}/members/${target.principalId}`,
          {
            method,
            headers: { ...owner.auth, "content-type": "application/json" },
            ...(method === "PATCH"
              ? { body: JSON.stringify({ role: "admin" }) }
              : {}),
          },
        );
        expect(
          await Promise.race([
            mutationReachedHost.then(() => "reached-host"),
            new Promise<string>((resolve) =>
              setImmediate(() => resolve("blocked-at-fence")),
            ),
          ]),
        ).toBe("blocked-at-fence");

        releaseApproval(
          new Response(JSON.stringify({ status: "approved" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
        expect((await approval).status).toBe(200);
        expect((await mutation).status).toBe(method === "PATCH" ? 200 : 204);
        await mutationReachedHost;
        expect(hostUrls.map((url) => new URL(url).pathname)).toEqual([
          "/api/v1/device/approve",
          "/api/v1/sessions/revoke",
        ]);
      } finally {
        host.mockRestore();
      }
    },
  );

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

describe("projects hierarchy and sharing", () => {
  const config = {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  };

  it("provisions one personal project and uses it as the active default", async () => {
    const { app } = createControlPlane({ config });
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };

    const list = await app.request("/v1/projects", { headers: auth });
    expect(list.status).toBe(200);
    const { projects } = (await list.json()) as {
      projects: Array<{
        id: string;
        kind: string;
        role: string;
        state: string;
      }>;
    };
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      kind: "personal",
      role: "owner",
      state: "active",
    });

    // Listing again must not mint a second personal project.
    const again = await app.request("/v1/projects", { headers: auth });
    expect(
      ((await again.json()) as { projects: unknown[] }).projects,
    ).toHaveLength(1);

    const active = await app.request("/v1/projects/active", { headers: auth });
    expect(active.status).toBe(200);
    const activeBody = (await active.json()) as {
      project: { id: string };
      isFallback: boolean;
    };
    expect(activeBody.isFallback).toBe(true);
    expect(activeBody.project.id).toBe(projects[0]?.id);
  });

  it("denies standard project creation to provisional principals", async () => {
    const { app } = createControlPlane({ config });
    const created = await provisional(app);
    const res = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ displayName: "Nope" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reasons: string[] };
    expect(body.reasons).toContain("provisional_action_not_permitted");
  });

  it("creates, swaps to, shares, and unshares a project", async () => {
    const { app } = createControlPlane({ config });
    const owner = await verifiedPrincipal(app, "project-owner");
    const member = await verifiedPrincipal(app, "project-member");

    const created = await app.request("/v1/projects", {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Shared Research" }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as {
      id: string;
      kind: string;
      slug: string;
      role: string;
    };
    expect(project.kind).toBe("standard");
    expect(project.slug).toBe("shared-research");
    expect(project.role).toBe("owner");

    // Swap the owner's active project to the new one.
    const swapped = await app.request("/v1/projects/active", {
      method: "PUT",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(swapped.status).toBe(200);
    expect(
      (await swapped.json()) as {
        project: { id: string };
        isFallback: boolean;
      },
    ).toMatchObject({ project: { id: project.id }, isFallback: false });

    // Before sharing, the other principal cannot see it.
    const before = await app.request(`/v1/projects/${project.id}`, {
      headers: member.auth,
    });
    expect(before.status).toBe(404);

    const share = await app.request(`/v1/projects/${project.id}/members`, {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ principalId: member.principalId, role: "member" }),
    });
    expect(share.status).toBe(201);

    // The member now sees the shared project alongside their personal one.
    const memberList = await app.request("/v1/projects", {
      headers: member.auth,
    });
    const memberProjects = (
      (await memberList.json()) as {
        projects: Array<{ id: string; role: string; kind: string }>;
      }
    ).projects;
    expect(memberProjects).toHaveLength(2);
    expect(
      memberProjects.find((entry) => entry.id === project.id),
    ).toMatchObject({ role: "member", kind: "standard" });

    // A plain member cannot manage sharing.
    const memberShare = await app.request(
      `/v1/projects/${project.id}/members`,
      {
        method: "POST",
        headers: { ...member.auth, "content-type": "application/json" },
        body: JSON.stringify({
          principalId: owner.principalId,
          role: "member",
        }),
      },
    );
    expect(memberShare.status).toBe(403);

    // Members can swap to the shared project.
    const memberSwap = await app.request("/v1/projects/active", {
      method: "PUT",
      headers: { ...member.auth, "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(memberSwap.status).toBe(200);

    // Unshare: the member loses the project and falls back to personal.
    const remove = await app.request(
      `/v1/projects/${project.id}/members/${member.principalId}`,
      { method: "DELETE", headers: owner.auth },
    );
    expect(remove.status).toBe(204);
    const afterRemove = await app.request(`/v1/projects/${project.id}`, {
      headers: member.auth,
    });
    expect(afterRemove.status).toBe(404);
    const memberActive = await app.request("/v1/projects/active", {
      headers: member.auth,
    });
    expect(
      (await memberActive.json()) as {
        isFallback: boolean;
        project: { kind: string };
      },
    ).toMatchObject({ isFallback: true, project: { kind: "personal" } });
  });

  it("keeps the personal project unshareable, undeletable, and quota-free", async () => {
    const { app } = createControlPlane({ config });
    const owner = await verifiedPrincipal(app, "personal-owner");
    const other = await verifiedPrincipal(app, "personal-other");

    const list = await app.request("/v1/projects", { headers: owner.auth });
    const personal = (
      (await list.json()) as { projects: Array<{ id: string; kind: string }> }
    ).projects.find((entry) => entry.kind === "personal");
    expect(personal).toBeDefined();
    if (!personal) throw new Error("personal project missing");

    const share = await app.request(`/v1/projects/${personal.id}/members`, {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ principalId: other.principalId, role: "member" }),
    });
    expect(share.status).toBe(409);
    expect((await share.json()) as { error: string }).toEqual({
      error: "personal_project_not_shareable",
    });

    const del = await app.request(`/v1/projects/${personal.id}`, {
      method: "DELETE",
      headers: owner.auth,
    });
    expect(del.status).toBe(409);
    expect((await del.json()) as { error: string }).toEqual({
      error: "personal_project_immutable",
    });
  });

  it("fences the last owner and owner-role grants", async () => {
    const { app } = createControlPlane({ config });
    const owner = await verifiedPrincipal(app, "fence-owner");
    const admin = await verifiedPrincipal(app, "fence-admin");

    const created = await app.request("/v1/projects", {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Fenced" }),
    });
    const project = (await created.json()) as { id: string };

    await app.request(`/v1/projects/${project.id}/members`, {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ principalId: admin.principalId, role: "admin" }),
    });

    // An admin cannot mint or demote owners.
    const adminMint = await app.request(
      `/v1/projects/${project.id}/members/${owner.principalId}`,
      {
        method: "PATCH",
        headers: { ...admin.auth, "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
    );
    expect(adminMint.status).toBe(403);

    // The last owner can be neither demoted nor removed.
    const demote = await app.request(
      `/v1/projects/${project.id}/members/${owner.principalId}`,
      {
        method: "PATCH",
        headers: { ...owner.auth, "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
    );
    expect(demote.status).toBe(409);
    const removeSelf = await app.request(
      `/v1/projects/${project.id}/members/${owner.principalId}`,
      { method: "DELETE", headers: owner.auth },
    );
    expect(removeSelf.status).toBe(409);
  });

  it("falls back to personal after the active project is deleted", async () => {
    const { app } = createControlPlane({ config });
    const owner = await verifiedPrincipal(app, "delete-owner");

    const created = await app.request("/v1/projects", {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Doomed" }),
    });
    const project = (await created.json()) as { id: string };

    await app.request("/v1/projects/active", {
      method: "PUT",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });

    const del = await app.request(`/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: owner.auth,
    });
    expect(del.status).toBe(204);

    const active = await app.request("/v1/projects/active", {
      headers: owner.auth,
    });
    expect(
      (await active.json()) as {
        isFallback: boolean;
        project: { kind: string };
      },
    ).toMatchObject({ isFallback: true, project: { kind: "personal" } });

    const gone = await app.request(`/v1/projects/${project.id}`, {
      headers: owner.auth,
    });
    expect(gone.status).toBe(404);
  });

  it("registers agents into the caller's active project", async () => {
    const { app } = createControlPlane({ config });
    const owner = await verifiedPrincipal(app, "agent-owner");

    const personalList = await app.request("/v1/projects", {
      headers: owner.auth,
    });
    const personal = (
      (await personalList.json()) as {
        projects: Array<{ id: string; kind: string }>;
      }
    ).projects.find((entry) => entry.kind === "personal");
    if (!personal) throw new Error("personal project missing");

    const first = await app.request("/v1/agents", {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Default Agent",
        publicKeyJkt: "jkt-default-agent",
      }),
    });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { projectId: string }).projectId).toBe(
      personal.id,
    );

    const created = await app.request("/v1/projects", {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Agent Home" }),
    });
    const project = (await created.json()) as { id: string };
    await app.request("/v1/projects/active", {
      method: "PUT",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });

    const second = await app.request("/v1/agents", {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Scoped Agent",
        publicKeyJkt: "jkt-scoped-agent",
      }),
    });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { projectId: string }).projectId).toBe(
      project.id,
    );
  });
});
