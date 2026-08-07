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

    const present = await app.request("/v1/claims/present", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ token: project.claimToken }),
    });
    expect(present.status).toBe(200);

    const complete = await app.request(`/v1/claims/${project.claimId}/complete`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "idempotency-key": "complete-1" },
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
    // Without allowDevDefaults, provisional creation still works if pepper set;
    // register+assert with stub signature must fail SimpleWebAuthn verify.
    const created = await provisional(app);
    const auth = { authorization: `Bearer ${created.accessToken}` };
    await app.request("/v1/mfa/passkey/register", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        credentialId: "cred_prod_1",
        publicKey: Buffer.from("pk").toString("base64"),
      }),
    });
    const assertRes = await app.request("/v1/mfa/passkey/assert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credentialId: "cred_prod_1",
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
