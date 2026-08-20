import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { overlapCast } from "@opensesame/os-domain";

type App = ReturnType<typeof createControlPlane>["app"];

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function assertBody(credentialId: string) {
  return {
    credentialId,
    clientDataJSON: Buffer.from("{}").toString("base64"),
    authenticatorData: Buffer.from("a").toString("base64"),
    signature: Buffer.from("sig").toString("base64"),
  };
}

describe("mfa routes edge cases", () => {
  it("issues authentication options in dev mode too", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const res = await app.request("/v1/mfa/passkey/authentication-options", {
      method: "POST",
      headers: auth(owner.accessToken),
    });
    expect(res.status).toBe(200);
    const body = overlapCast(await res.json());
    expect(body.ok).toBe(true);
    expect(body.challenge.length).toBeGreaterThan(8);
  });

  it("rejects malformed dev passkey registrations", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);

    const missingKey = await app.request("/v1/mfa/passkey/register", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ credentialId: "cred_no_key" }),
    });
    expect(missingKey.status).toBe(400);
    expect((overlapCast(await missingKey.json())).error).toBe(
      "invalid_request",
    );

    // With a public key the stub registration succeeds, counter defaulting to 0.
    const ok = await app.request("/v1/mfa/passkey/register", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        credentialId: "cred_ok",
        publicKey: Buffer.from("pk").toString("base64"),
      }),
    });
    expect(ok.status).toBe(200);
    expect((overlapCast(await ok.json())).credentialId).toBe(
      "cred_ok",
    );
  });

  it("rejects malformed passkey assertions before verification", async () => {
    const { app } = createControlPlane({ config: testConfig() });

    const missingSignature = await app.request("/v1/mfa/passkey/assert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentialId: "cred_x" }),
    });
    expect(missingSignature.status).toBe(400);

    const oversized = await app.request("/v1/mfa/passkey/assert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...assertBody("cred_x"),
        signature: "x".repeat(17 * 1024),
      }),
    });
    expect(oversized.status).toBe(400);
    expect((overlapCast(await oversized.json())).error).toBe(
      "invalid_request",
    );
  });

  it("rate-limits anonymous passkey assertions per fingerprint", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const attempt = (n: number) =>
      app.request("/v1/mfa/passkey/assert", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "anon-budget-probe",
        },
        body: JSON.stringify(assertBody(`cred_ratelimit_${n}`)),
      });

    for (let i = 0; i < 20; i += 1) {
      expect((await attempt(i)).status).toBe(401);
    }
    const limited = await attempt(20);
    expect(limited.status).toBe(429);
    expect((overlapCast(await limited.json())).error).toBe(
      "rate_limited",
    );
  });

  it("prunes the failure fence when it overflows", async () => {
    const { app, ctx } = createControlPlane({ config: testConfig() });
    for (let i = 0; i < 4097; i += 1) {
      ctx.stores.mfaFailures.set(`stale:${i}`, 1);
    }
    const res = await app.request("/v1/mfa/passkey/assert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(assertBody("cred_prune")),
    });
    expect(res.status).toBe(401);
    // The oldest entry was evicted to make room before this attempt was counted.
    expect(ctx.stores.mfaFailures.has("stale:0")).toBe(false);
    expect(ctx.stores.mfaFailures.has("stale:1")).toBe(true);
  });

  it("binds TOTP verification to the authenticated principal", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);

    const mismatch = await app.request("/v1/mfa/totp/verify", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: "000000", principalId: "prn_someone_else" }),
    });
    expect(mismatch.status).toBe(403);
    expect((overlapCast(await mismatch.json())).error).toBe(
      "principal_mismatch",
    );

    const notEnrolled = await app.request("/v1/mfa/totp/verify", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(notEnrolled.status).toBe(404);
    expect((overlapCast(await notEnrolled.json())).error).toBe(
      "not_enrolled",
    );
  });

  it("rejects wrong-length TOTP codes without touching the fence unfairly", async () => {
    const { app } = createControlPlane({ config: testConfig() });
    const owner = await provisional(app);
    const enroll = await app.request("/v1/mfa/totp/enroll", {
      method: "POST",
      headers: auth(owner.accessToken),
    });
    expect(enroll.status).toBe(200);

    const short = await app.request("/v1/mfa/totp/verify", {
      method: "POST",
      headers: {
        ...auth(owner.accessToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: "12345" }),
    });
    expect(short.status).toBe(401);
    expect((overlapCast(await short.json())).ok).toBe(false);
  });
});
