import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { AuthError } from "./errors.js";
import { verifyIdToken } from "./id-token.js";

const ISSUER = "http://127.0.0.1:8788";
const AUDIENCE = "origin:https://app.example.com";

async function mintKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

describe("verifyIdToken", () => {
  it("verifies iss, aud, exp, and nonce", async () => {
    const { privateKey, jwks } = await mintKeys();
    const token = await new SignJWT({ nonce: "abc" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("pairwise-sub")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const verified = await verifyIdToken(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
      nonce: "abc",
    });
    expect(verified.sub).toBe("pairwise-sub");
    expect(verified.nonce).toBe("abc");
  });

  it("maps a nonce mismatch to AuthError", async () => {
    const { privateKey, jwks } = await mintKeys();
    const token = await new SignJWT({ nonce: "other" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("pairwise-sub")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyIdToken(token, {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks,
        nonce: "abc",
      }),
    ).rejects.toMatchObject({ name: "AuthError", code: "nonce_mismatch" });
  });

  it("rejects HS256 and none", async () => {
    await expect(
      verifyIdToken("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.", {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: { keys: [] },
      }),
    ).rejects.toBeInstanceOf(AuthError);

    const none = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "x", iss: ISSUER, aud: AUDIENCE, exp: 9999999999 })).toString("base64url")}.sig`;
    await expect(
      verifyIdToken(none, {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: { keys: [] },
      }),
    ).rejects.toMatchObject({ code: "invalid_algorithm" });
  });

  it("maps a wrong audience to invalid_audience", async () => {
    const { privateKey, jwks } = await mintKeys();
    const token = await new SignJWT({ nonce: "abc" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience("other")
      .setSubject("pairwise-sub")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyIdToken(token, {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks,
        nonce: "abc",
      }),
    ).rejects.toMatchObject({ code: "invalid_audience" });
  });

  it("refuses a remote issuer that points JWKS at private space", async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "x",
        iss: "https://remote.example",
        aud: AUDIENCE,
      }),
    ).toString("base64url");
    await expect(
      verifyIdToken(`${header}.${payload}.sig`, {
        issuer: "https://remote.example",
        audience: AUDIENCE,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              issuer: "https://remote.example",
              jwks_uri: "http://127.0.0.1:9200/jwks",
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toThrow(/private or loopback host|must use https/u);
  });
});
