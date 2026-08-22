import { overlapCast } from "@opensesame/os-domain";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlane } from "../create-app.js";
import { orgAssertionSeams } from "../routes/org-assertion.js";

const ISSUER = "http://127.0.0.1:9090";

async function mintKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "claim-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

async function guest(app: ReturnType<typeof createControlPlane>["app"]) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

describe("claiming a guest principal with an upstream id_token", () => {
  const originalDiscover = orgAssertionSeams.discoverJwksUri;

  afterEach(() => {
    orgAssertionSeams.discoverJwksUri = originalDiscover;
    vi.unstubAllGlobals();
  });

  it("promotes the same principal when the id_token verifies", async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );

    const { app } = createControlPlane();
    const created = await guest(app);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "claim-1" })
      .setIssuer(ISSUER)
      .setSubject("alice@upstream")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(linked.status).toBe(201);
    expect(overlapCast(await linked.json())).toMatchObject({
      principalId: created.principalId,
      identity: {
        issuer: ISSUER,
        subject: "alice@upstream",
        assurance: "verified",
      },
    });

    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(overlapCast(await me.json())).toMatchObject({
      id: created.principalId,
      assurance: "verified",
    });
  });

  it("promotes the same principal when self-asserted links are off", async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );

    const { app } = createControlPlane({
      config: {
        port: 0,
        publicUrl: "http://127.0.0.1:8788",
        issuer: "http://127.0.0.1:8788",
        allowDevDefaults: false,
        claimPepper: "prod-claim-pepper-for-test-only",
        isProduction: false,
        trustedUpstreamIssuers: [ISSUER],
      },
      processEnv: {
        ...process.env,
        OPENSESAME_ALLOW_DEV_DEFAULTS: "false",
        OPENSESAME_CLAIM_PEPPER: "prod-claim-pepper-for-test-only",
        NODE_ENV: "development",
      },
    });
    const created = await guest(app);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "claim-1" })
      .setIssuer(ISSUER)
      .setSubject("alice@upstream")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(linked.status).toBe(201);
    expect(overlapCast(await linked.json()).principalId).toBe(
      created.principalId,
    );

    const me = await app.request("/v1/principals/me", {
      headers: { authorization: `Bearer ${created.accessToken}` },
    });
    expect(overlapCast(await me.json())).toMatchObject({
      id: created.principalId,
      assurance: "verified",
    });
  });

  it("refuses an issuer that is not on the allowlist", async () => {
    const { app } = createControlPlane();
    const created = await guest(app);
    const token = [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({ iss: "https://evil.example", sub: "x" }),
      ).toString("base64url"),
      "sig",
    ].join(".");
    const linked = await app.request("/v1/principals/link-identities", {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(linked.status).toBe(403);
    expect(overlapCast(await linked.json()).error).toBe("untrusted_issuer");
  });
});
