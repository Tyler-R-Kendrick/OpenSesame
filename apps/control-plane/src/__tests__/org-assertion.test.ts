import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrgAssertionError,
  orgAssertionSeams,
  verifyOrgIdToken,
} from "../routes/org-assertion.js";

const ISSUER = "http://127.0.0.1:9090";

async function mintKeys() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "org-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

describe("verifyOrgIdToken", () => {
  const originalDiscover = orgAssertionSeams.discoverJwksUri;

  afterEach(() => {
    orgAssertionSeams.discoverJwksUri = originalDiscover;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("accepts a signed org assertion with sub", async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "org-1" })
      .setIssuer(ISSUER)
      .setSubject("dir-user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifyOrgIdToken(token, ISSUER)).resolves.toEqual({
      sub: "dir-user-1",
    });
  });

  it("prefers pairwise_sub when both are present", async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );

    const token = await new SignJWT({ pairwise_sub: "pair-1" })
      .setProtectedHeader({ alg: "RS256", kid: "org-1" })
      .setIssuer(ISSUER)
      .setSubject("dir-user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifyOrgIdToken(token, ISSUER)).resolves.toEqual({
      sub: "pair-1",
    });
  });

  it("rejects alg none", async () => {
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "x", iss: ISSUER })).toString("base64url")}.`;
    await expect(verifyOrgIdToken(none, ISSUER)).rejects.toMatchObject({
      name: "OrgAssertionError",
      code: "invalid_token",
    });
  });

  it("surfaces discovery failure", async () => {
    orgAssertionSeams.discoverJwksUri = async () => {
      throw new OrgAssertionError("upstream_unavailable", "down");
    };
    const { privateKey } = await mintKeys();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "org-1" })
      .setIssuer(ISSUER)
      .setSubject("dir-user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyOrgIdToken(token, ISSUER)).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });
});
