import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrgAssertionError,
  orgAssertionSeams,
  originAudiences,
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

  it("checks the audience only when the caller names one", async () => {
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
      .setAudience("origin:http://localhost:5180")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    // No options: byte-identical to the pre-hardening behaviour, which the
    // server-side leg depends on.
    await expect(verifyOrgIdToken(token, ISSUER)).resolves.toEqual({
      sub: "dir-user-1",
    });
    await expect(
      verifyOrgIdToken(token, ISSUER, {
        expectedAudiences: [
          "origin:http://127.0.0.1:8788",
          "origin:http://localhost:5180",
        ],
      }),
    ).resolves.toEqual({ sub: "dir-user-1" });
    await expect(
      verifyOrgIdToken(token, ISSUER, {
        expectedAudiences: ["origin:https://someone.else"],
      }),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("bounds token age from iat when the caller sets a window", async () => {
    const { privateKey, jwks } = await mintKeys();
    orgAssertionSeams.discoverJwksUri = async () => `${ISSUER}/jwks`;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(jwks))),
    );
    const issuedAt = Math.floor(Date.now() / 1000) - 700;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "org-1" })
      .setIssuer(ISSUER)
      .setSubject("dir-user-1")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(privateKey);

    // Still inside its own expiry — only the age fence can refuse it.
    await expect(verifyOrgIdToken(token, ISSUER)).resolves.toEqual({
      sub: "dir-user-1",
    });
    await expect(
      verifyOrgIdToken(token, ISSUER, { maxTokenAgeSec: 600 }),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("refuses to dereference a private-host issuer when the guard is on", async () => {
    orgAssertionSeams.discoverJwksUri = originalDiscover;
    const token = "not-even-read";
    await expect(
      verifyOrgIdToken(token, "http://169.254.169.254", {
        blockPrivateIssuerHosts: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_token" });

    // The guard fires before any network call — nothing was fetched.
    const fetchSpy = vi.fn(() => Promise.resolve(Response.json({})));
    vi.stubGlobal("fetch", fetchSpy);
    const { privateKey } = await mintKeys();
    const signed = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "org-1" })
      .setIssuer("http://169.254.169.254")
      .setSubject("dir-user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(
      verifyOrgIdToken(signed, "http://169.254.169.254", {
        blockPrivateIssuerHosts: true,
      }),
    ).rejects.toMatchObject({ code: "unsafe_issuer" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("derives the accepted audience set from every configured surface", () => {
    expect(
      originAudiences({
        corsOrigins: [
          "http://localhost:5180",
          "http://localhost:5180/",
          "not a url",
        ],
        publicUrl: "http://127.0.0.1:8788",
      }),
    ).toEqual(["origin:http://localhost:5180", "origin:http://127.0.0.1:8788"]);
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
