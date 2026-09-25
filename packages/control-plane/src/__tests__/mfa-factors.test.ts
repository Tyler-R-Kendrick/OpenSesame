import { overlapCast, parseAccountFactorList } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { passkeyDigest } from "../routes/mfa-factors.js";

type App = ReturnType<typeof createControlPlane>["app"];

const DEV = {
  port: 0,
  publicUrl: "http://127.0.0.1:8788",
  issuer: "http://127.0.0.1:8788",
} as const;

async function provisional(app: App): Promise<string> {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json()).accessToken;
}

function auth(token: string, json = false) {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function registerPasskey(app: App, token: string, credentialId: string) {
  const res = await app.request("/v1/mfa/passkey/register", {
    method: "POST",
    headers: auth(token, true),
    body: JSON.stringify({
      credentialId,
      publicKey: Buffer.from(`public-key-of-${credentialId}`).toString(
        "base64",
      ),
      counter: 41,
    }),
  });
  expect(res.status).toBe(200);
}

async function enrollTotp(app: App, token: string): Promise<string> {
  const res = await app.request("/v1/mfa/totp/enroll", {
    method: "POST",
    headers: auth(token),
  });
  expect(res.status).toBe(200);
  return overlapCast(await res.json()).secret;
}

async function list(app: App, token: string) {
  const res = await app.request("/v1/mfa/factors", { headers: auth(token) });
  return { res, text: await res.text() };
}

function remove(app: App, token: string, id: string) {
  return app.request(`/v1/mfa/factors/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: auth(token),
  });
}

describe("GET /v1/mfa/factors", () => {
  it("lists the caller's own factors, display-safe", async () => {
    const { app } = createControlPlane({ config: DEV });
    const token = await provisional(app);
    await registerPasskey(app, token, "cred_alice_one");
    const secret = await enrollTotp(app, token);

    const { res, text } = await list(app, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const parsed = parseAccountFactorList(overlapCast(JSON.parse(text)));
    expect(parsed?.enrollable).toEqual(["passkey", "totp"]);
    expect(parsed?.factors).toEqual([
      {
        id: `pk_${passkeyDigest("cred_alice_one")}`,
        kind: "passkey",
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
      { id: "totp", kind: "totp" },
    ]);
    // Nothing that verifies a factor, and not the raw credential id.
    expect(text).not.toContain("cred_alice_one");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(
      Buffer.from("public-key-of-cred_alice_one").toString("base64"),
    );
    expect(text).not.toMatch(/publicKey|counter|secret|seed/i);
  });

  it("requires a session", async () => {
    const { app } = createControlPlane({ config: DEV });
    const res = await app.request("/v1/mfa/factors");
    expect(res.status).toBe(401);
    const del = await app.request("/v1/mfa/factors/totp", {
      method: "DELETE",
    });
    expect(del.status).toBe(401);
  });

  it("never lists another principal's factors", async () => {
    const { app } = createControlPlane({ config: DEV });
    const alice = await provisional(app);
    const mallory = await provisional(app);
    await registerPasskey(app, alice, "cred_alice");
    await enrollTotp(app, alice);

    const { text } = await list(app, mallory);
    expect(
      parseAccountFactorList(overlapCast(JSON.parse(text)))?.factors,
    ).toEqual([]);
  });

  it("offers only passkeys where TOTP enrolment is refused", async () => {
    const { app } = createControlPlane({
      config: {
        ...DEV,
        allowDevDefaults: false,
        claimPepper: "prod-claim-pepper-for-test-only",
        isProduction: false,
      },
      processEnv: {
        ...process.env,
        OPENSESAME_ALLOW_DEV_DEFAULTS: "0",
        OPENSESAME_CLAIM_PEPPER: "prod-claim-pepper-for-test-only",
        NODE_ENV: "development",
      },
    });
    const token = await provisional(app);
    const { text } = await list(app, token);
    expect(overlapCast(JSON.parse(text)).enrollable).toEqual(["passkey"]);
  });
});

describe("DELETE /v1/mfa/factors/:id", () => {
  it("removes the caller's own passkey and TOTP seed", async () => {
    const { app } = createControlPlane({ config: DEV });
    const token = await provisional(app);
    await registerPasskey(app, token, "cred_one");
    await registerPasskey(app, token, "cred_two");
    await enrollTotp(app, token);
    const id = `pk_${passkeyDigest("cred_one")}`;

    const gone = await remove(app, token, id);
    expect(gone.status).toBe(200);
    expect(overlapCast(await gone.json())).toEqual({
      ok: true,
      id,
      kind: "passkey",
    });
    const totp = await remove(app, token, "totp");
    expect(totp.status).toBe(200);

    const { text } = await list(app, token);
    expect(
      parseAccountFactorList(overlapCast(JSON.parse(text)))?.factors.map(
        (factor) => factor.id,
      ),
    ).toEqual([`pk_${passkeyDigest("cred_two")}`]);
    // The removed seed no longer verifies anything.
    const verify = await app.request("/v1/mfa/totp/verify", {
      method: "POST",
      headers: auth(token, true),
      body: JSON.stringify({ code: "000000" }),
    });
    expect(verify.status).toBe(404);
    // And the removed credential no longer asserts.
    const assert = await app.request("/v1/mfa/passkey/assert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credentialId: "cred_one",
        clientDataJSON: Buffer.from("{}").toString("base64"),
        authenticatorData: Buffer.from("a").toString("base64"),
        signature: Buffer.from("sig").toString("base64"),
      }),
    });
    expect(assert.status).toBe(401);
  });

  it("never deletes another principal's factor, and says nothing about it", async () => {
    const { app } = createControlPlane({ config: DEV });
    const alice = await provisional(app);
    const mallory = await provisional(app);
    await registerPasskey(app, alice, "cred_alice");
    await enrollTotp(app, alice);
    const aliceKey = `pk_${passkeyDigest("cred_alice")}`;

    const foreign = await remove(app, mallory, aliceKey);
    const missing = await remove(app, mallory, `pk_${"0".repeat(32)}`);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    // A foreign factor and a missing one answer byte for byte alike.
    expect(await foreign.text()).toBe(await missing.text());
    // Mallory's `totp` is her own (she has none), never Alice's.
    expect((await remove(app, mallory, "totp")).status).toBe(404);

    const { text } = await list(app, alice);
    expect(
      parseAccountFactorList(overlapCast(JSON.parse(text)))?.factors.map(
        (factor) => factor.id,
      ),
    ).toEqual([aliceKey, "totp"]);
  });

  it("refuses anything but a factor id", async () => {
    const { app } = createControlPlane({ config: DEV });
    const token = await provisional(app);
    await registerPasskey(app, token, "cred_raw");
    for (const id of ["cred_raw", "pk_short", `pk_${"G".repeat(32)}`]) {
      const res = await remove(app, token, id);
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /v1/mfa/passkey/register in a development build", () => {
  it("verifies a browser's attestation rather than refusing it as a stub", async () => {
    const { app } = createControlPlane({ config: DEV });
    const token = await provisional(app);
    const res = await app.request("/v1/mfa/passkey/register", {
      method: "POST",
      headers: auth(token, true),
      body: JSON.stringify({
        response: {
          id: "cred_x",
          rawId: "cred_x",
          type: "public-key",
          response: { clientDataJSON: "e30", attestationObject: "AA" },
          clientExtensionResults: {},
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(overlapCast(await res.json()).error).toBe(
      "registration_verification_failed",
    );
    const { text } = await list(app, token);
    expect(overlapCast(JSON.parse(text)).factors).toEqual([]);
  });
});
