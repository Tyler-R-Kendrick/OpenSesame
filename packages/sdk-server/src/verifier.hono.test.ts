import { Hono } from "hono";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { type OpenSesameAuthVariables, openSesameAuth } from "./hono.js";
import { AUDIENCE, ISSUER, mintKeys } from "./verifier-test-support.js";
import { createOpenSesameVerifier } from "./verifier.js";

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

  it("challenges without describing why the token failed", async () => {
    const { jwks } = await mintKeys();
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
    });
    const app = new Hono<{ Variables: OpenSesameAuthVariables }>();
    app.use("/me", openSesameAuth({ verifier }));
    app.get("/me", (c) => c.json({ sub: c.get("identity").sub }));

    const res = await app.request("http://localhost/me", {
      headers: { authorization: "Bearer not.a.token" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toEqual({
      error: "invalid_token",
      error_description: "The access token is not valid",
    });
  });

  it("does not report a handler's own failure as an invalid token", async () => {
    const { privateKey, jwks } = await mintKeys();
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
    });
    const app = new Hono<{ Variables: OpenSesameAuthVariables }>();
    app.use("/boom", openSesameAuth({ verifier }));
    app.get("/boom", () => {
      throw new Error("connection string leaked here");
    });
    app.onError((_e, c) => c.json({ error: "internal" }, 500));

    const token = await new SignJWT({ scope: "openid" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("pairwise-alpha-sub")
      .setExpirationTime("5m")
      .sign(privateKey);

    const res = await app.request("http://localhost/boom", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("connection string leaked here");
  });

  it("maps AuthorizationError to 403 with the coded JSON body", async () => {
    const { privateKey, jwks } = await mintKeys();
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
      requiredScopes: ["admin"],
    });
    const app = new Hono<{ Variables: OpenSesameAuthVariables }>();
    app.use("/me", openSesameAuth({ verifier }));
    app.get("/me", (c) => c.json({ sub: c.get("identity").sub }));

    const token = await new SignJWT({ scope: "openid" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("pairwise-alpha-sub")
      .setExpirationTime("5m")
      .sign(privateKey);

    const res = await app.request("http://localhost/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "insufficient_scope",
      error_description: "Token missing required scopes",
    });
  });
});
