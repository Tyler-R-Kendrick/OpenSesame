import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createOpenSesameVerifier } from "./verifier.js";
import { openSesameAuth, type OpenSesameAuthVariables } from "./hono.js";

const ISSUER = "http://127.0.0.1:8788";
const AUDIENCE = "rp-alpha";

async function mintKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

describe("createOpenSesameVerifier", () => {
  it("verifies access token against local JWKS", async () => {
    const { privateKey, jwks } = await mintKeys();
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
    });

    const token = await new SignJWT({ scope: "openid profile", token_use: "access" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("pairwise-alpha-sub")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const identity = await verifier.verifyAccessToken(token);
    expect(identity.sub).toBe("pairwise-alpha-sub");
    expect(identity.iss).toBe(ISSUER);
    expect(identity.scope).toContain("openid");
  });

  it("rejects wrong audience", async () => {
    const { privateKey, jwks } = await mintKeys();
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
    });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience("rp-beta")
      .setSubject("x")
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });

  it("enforces required scopes", async () => {
    const { privateKey, jwks } = await mintKeys();
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
      requiredScopes: ["admin"],
    });
    const token = await new SignJWT({ scope: "openid" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("x")
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(/scopes/i);
  });
});

describe("openSesameAuth hono middleware", () => {
  it("sets identity on success and 401 on missing token", async () => {
    const { privateKey, jwks } = await mintKeys();
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
    });
    const app = new Hono<{ Variables: OpenSesameAuthVariables }>();
    app.use("/me", openSesameAuth({ verifier }));
    app.get("/me", (c) => c.json({ sub: c.get("identity").sub }));

    const missing = await app.request("http://localhost/me");
    expect(missing.status).toBe(401);

    const token = await new SignJWT({ scope: "openid" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("pairwise-alpha-sub")
      .setExpirationTime("5m")
      .sign(privateKey);

    const ok = await app.request("http://localhost/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sub: "pairwise-alpha-sub" });
  });
});
