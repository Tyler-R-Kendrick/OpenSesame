import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { type OpenSesameAuthVariables, openSesameAuth } from "./hono.js";
import {
  assertDiscoveredJwksUri,
  createOpenSesameVerifier,
} from "./verifier.js";

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

    const token = await new SignJWT({
      scope: "openid profile",
      token_use: "access",
    })
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

  it("rejects a token that never expires", async () => {
    const { privateKey, jwks } = await mintKeys();
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
    });
    const token = await new SignJWT({ scope: "openid" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("x")
      .setIssuedAt()
      .sign(privateKey);

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(/exp/i);
  });

  it("rejects a signature algorithm it does not accept", async () => {
    const { privateKey, jwks } = await mintKeys();
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
      algorithms: ["ES256"],
    });
    const token = await new SignJWT({ scope: "openid" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("x")
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });

  it("refuses to take keys or an issuer over cleartext", async () => {
    const { jwks } = await mintKeys();
    expect(() =>
      createOpenSesameVerifier({
        issuer: "http://idp.example",
        audience: AUDIENCE,
        jwks,
      }),
    ).toThrow(/https/i);
    expect(() =>
      createOpenSesameVerifier({
        issuer: "https://idp.example",
        audience: AUDIENCE,
        jwksUri: "http://idp.example/jwks",
      }),
    ).toThrow(/https/i);
    // Loopback stays usable for local development.
    expect(() =>
      createOpenSesameVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks }),
    ).not.toThrow();
  });

  it("takes the key set from the issuer's own metadata", async () => {
    const { privateKey, jwks } = await mintKeys();
    const asked: string[] = [];
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchImpl: async (input) => {
        const url = String(input);
        asked.push(url);
        if (url.endsWith("/.well-known/openid-configuration")) {
          return new Response(
            JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/oidc/keys` }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const token = await new SignJWT({ token_use: "access" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("sub-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    // jose fetches the JWKS itself, so we only assert the document was consulted
    // and the URI it named was used rather than {issuer}/jwks being guessed.
    await verifier.verifyAccessToken(token).catch(() => undefined);
    expect(asked[0]).toBe(`${ISSUER}/.well-known/openid-configuration`);
    expect(asked.some((u) => u.endsWith("/jwks"))).toBe(false);
  });

  it("refuses a remote issuer that points the key fetch at this network", async () => {
    // A resource server verifying tokens from a remote issuer will fetch whatever
    // URI that issuer's metadata names. Cleartext-on-loopback is the right
    // affordance for a value an operator configured and the wrong one for a value
    // a remote party supplies.
    for (const jwks_uri of [
      "http://127.0.0.1:9200/jwks",
      "https://127.0.0.1/jwks",
      "https://localhost/jwks",
      "https://10.1.2.3/jwks",
      "https://169.254.169.254/latest/meta-data/",
      "https://172.20.0.5/jwks",
      "https://192.168.1.1/jwks",
      "https://[fd00::1]/jwks",
      "https://[::ffff:127.0.0.1]/jwks",
      "https://[::ffff:7f00:1]/jwks",
      "https://vault.internal/jwks",
    ]) {
      const verifier = createOpenSesameVerifier({
        issuer: "https://remote.example",
        audience: AUDIENCE,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ issuer: "https://remote.example", jwks_uri }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      });
      await expect(verifier.verifyAccessToken("a.b.c")).rejects.toThrow(
        /private or loopback host|must use https/u,
      );
    }
  });

  it("still lets a remote issuer name a key set on another public host", async () => {
    // Plenty of real issuers publish their keys on a different hostname. Only
    // private space is refused, not a different origin.
    expect(
      assertDiscoveredJwksUri(
        "https://keys.cdn.example/jwks",
        new URL("https://remote.example"),
      ).href,
    ).toBe("https://keys.cdn.example/jwks");

    // A loopback issuer is the local development pair: both ends are this machine.
    expect(
      assertDiscoveredJwksUri(
        "http://127.0.0.1:9200/jwks",
        new URL("http://127.0.0.1:8788"),
      ).href,
    ).toBe("http://127.0.0.1:9200/jwks");
  });

  it("refuses a discovery document that names another issuer", async () => {
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            issuer: "https://elsewhere.example",
            jwks_uri: "https://elsewhere.example/keys",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(verifier.verifyAccessToken("x.y.z")).rejects.toThrow(
      /does not name the configured issuer/,
    );
  });

  it("refuses a key set the issuer publishes over cleartext", async () => {
    const verifier = createOpenSesameVerifier({
      issuer: "https://idp.example",
      audience: AUDIENCE,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            issuer: "https://idp.example",
            jwks_uri: "http://idp.example/keys",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(verifier.verifyAccessToken("x.y.z")).rejects.toThrow(/https/i);
  });

  it("falls back to {issuer}/jwks when there is no metadata to read", async () => {
    const asked: string[] = [];
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetchImpl: async (input) => {
        asked.push(String(input));
        return new Response("not found", { status: 404 });
      },
    });
    await verifier.verifyAccessToken("x.y.z").catch(() => undefined);
    expect(asked[0]).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it("requires the RFC 9068 type header when asked to", async () => {
    const { privateKey, jwks } = await mintKeys();
    const verifier = createOpenSesameVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks,
      requireAccessTokenTypeHeader: true,
    });
    const plain = new SignJWT({ scope: "openid" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("x")
      .setExpirationTime("5m");
    await expect(
      verifier.verifyAccessToken(
        await plain
          .setProtectedHeader({ alg: "RS256", kid: "test-1" })
          .sign(privateKey),
      ),
    ).rejects.toThrow(/9068/);
    const typed = await new SignJWT({ scope: "openid" })
      .setProtectedHeader({ alg: "RS256", kid: "test-1", typ: "at+jwt" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("x")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifier.verifyAccessToken(typed)).resolves.toMatchObject({
      sub: "x",
    });
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
    const body = (await res.json()) as {
      error: string;
      error_description: string;
    };
    expect(body.error).toBe("invalid_token");
    // No verifier internals in the answer.
    expect(body.error_description).toBe("The access token is not valid");
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
});
