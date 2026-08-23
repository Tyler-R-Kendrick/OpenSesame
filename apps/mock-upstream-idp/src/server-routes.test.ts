import { createHash, randomBytes } from "node:crypto";
import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { decodeJwt, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { createMockUpstreamIdp } from "./server.js";

interface AuthorizationParameters {
  state?: string;
  nonce?: string;
  scope?: string;
}

interface TokenRequestFields {
  grant_type: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  client_secret?: string;
  code_verifier?: string;
  refresh_token?: string;
}

interface TokenRequestHeaders {
  authorization?: string;
  origin?: string;
}

async function listenIdp(overrides: JsonObject = {}) {
  const idp = await createMockUpstreamIdp({
    host: "127.0.0.1",
    port: overlapCast(0),
    issuer: "http://127.0.0.1:0",
    ...overrides,
  });
  await new Promise<void>((resolve, reject) => {
    idp.server.listen(0, "127.0.0.1", () => resolve());
    idp.server.once("error", reject);
  });
  const addr = idp.server.address();
  if (!addr || isString(addr)) throw new Error("no address");
  const base = `http://127.0.0.1:${addr.port}`;
  idp.config.issuer = base;
  const redirectUri = `${base}/cb`;
  idp.config.redirectUris = [redirectUri];
  return { idp, base, redirectUri };
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function getCode(
  base: string,
  idp: Awaited<ReturnType<typeof createMockUpstreamIdp>>,
  redirectUri: string,
  extra: AuthorizationParameters = {},
) {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${base}/authorize`);
  url.searchParams.set("client_id", idp.config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { res, location, code, verifier };
}

function tokenRequest(
  base: string,
  body: TokenRequestFields,
  headers: TokenRequestHeaders = {},
) {
  return fetch(`${base}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(Object.entries(body)),
  });
}

describe("mock-upstream-idp route branches", () => {
  it("rejects invalid client, redirect_uri, response_type, and PKCE method on /authorize", async () => {
    const { idp, base, redirectUri } = await listenIdp();
    try {
      const build = () => {
        const url = new URL(`${base}/authorize`);
        url.searchParams.set("client_id", idp.config.clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("code_challenge", s256("v"));
        url.searchParams.set("code_challenge_method", "S256");
        return url;
      };

      const badClient = build();
      badClient.searchParams.set("client_id", "someone-else");
      const r1 = await fetch(badClient, { redirect: "manual" });
      expect(r1.status).toBe(400);
      expect(overlapCast(await r1.json()).error).toBe("invalid_client");

      const badRedirect = build();
      badRedirect.searchParams.set("redirect_uri", "http://evil.example/cb");
      const r2 = await fetch(badRedirect, { redirect: "manual" });
      expect(r2.status).toBe(400);
      expect(overlapCast(await r2.json()).error).toBe("invalid_redirect_uri");

      const badType = build();
      badType.searchParams.set("response_type", "token");
      const r3 = await fetch(badType, { redirect: "manual" });
      expect(r3.status).toBe(400);
      expect(overlapCast(await r3.json()).error).toBe(
        "unsupported_response_type",
      );

      const plainPkce = build();
      plainPkce.searchParams.set("code_challenge_method", "plain");
      const r4 = await fetch(plainPkce, { redirect: "manual" });
      expect(r4.status).toBe(400);
      expect(overlapCast(await r4.json()).error).toBe("invalid_request");
    } finally {
      await idp.close();
    }
  });

  it("issues an RS256 id_token verifiable via the published JWKS, echoing state and nonce", async () => {
    const { idp, base, redirectUri } = await listenIdp();
    try {
      const { res, location, code, verifier } = await getCode(
        base,
        idp,
        redirectUri,
        { state: "st-1", nonce: "nonce-1", scope: "openid profile email" },
      );
      expect(res.status).toBe(302);
      if (!location) throw new Error("no location");
      expect(new URL(location).searchParams.get("state")).toBe("st-1");
      if (!code) throw new Error("no code");

      const tokenRes = await tokenRequest(base, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: idp.config.clientId,
        client_secret: idp.config.clientSecret,
        code_verifier: verifier,
      });
      expect(tokenRes.status).toBe(200);
      const tokens = overlapCast(await tokenRes.json());
      expect(tokens.token_type).toBe("Bearer");
      expect(tokens.refresh_token).toBe(
        `mock-refresh-${idp.config.testUser.sub}`,
      );
      expect(tokens.scope).toBe("openid profile email");

      const key = await importJWK(idp.keys.publicJwk, "RS256");
      const { payload } = await jwtVerify(tokens.id_token, key, {
        issuer: base,
        audience: idp.config.clientId,
      });
      expect(payload.sub).toBe(idp.config.testUser.sub);
      expect(payload.email).toBe(idp.config.testUser.email);
      expect(payload.name).toBe(idp.config.testUser.name);
      expect(payload.nonce).toBe("nonce-1");
    } finally {
      await idp.close();
    }
  });

  it("omits state from the redirect and nonce from the id_token when not requested", async () => {
    const { idp, base, redirectUri } = await listenIdp();
    try {
      const { res, location, code, verifier } = await getCode(
        base,
        idp,
        redirectUri,
      );
      expect(res.status).toBe(302);
      if (!location) throw new Error("no location");
      expect(new URL(location).searchParams.has("state")).toBe(false);
      if (!code) throw new Error("no code");

      const tokenRes = await tokenRequest(base, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: idp.config.clientId,
        client_secret: idp.config.clientSecret,
        code_verifier: verifier,
      });
      expect(tokenRes.status).toBe(200);
      const tokens = overlapCast(await tokenRes.json());
      const payload = decodeJwt(tokens.id_token);
      expect(payload.nonce).toBeUndefined();
      // default scope when none is requested
      expect((await Promise.resolve(payload)).sub).toBe(
        idp.config.testUser.sub,
      );
    } finally {
      await idp.close();
    }
  });

  it("rejects token exchange for unknown codes and mismatched redirect_uri", async () => {
    const { idp, base, redirectUri } = await listenIdp();
    try {
      const unknown = await tokenRequest(base, {
        grant_type: "authorization_code",
        code: "code_does-not-exist",
        redirect_uri: redirectUri,
        client_id: idp.config.clientId,
        client_secret: idp.config.clientSecret,
        code_verifier: "whatever",
      });
      expect(unknown.status).toBe(400);
      expect(overlapCast(await unknown.json()).error).toBe("invalid_grant");

      const { code, verifier } = await getCode(base, idp, redirectUri);
      if (!code) throw new Error("no code");
      const mismatched = await tokenRequest(base, {
        grant_type: "authorization_code",
        code,
        redirect_uri: `${redirectUri}/other`,
        client_id: idp.config.clientId,
        client_secret: idp.config.clientSecret,
        code_verifier: verifier,
      });
      expect(mismatched.status).toBe(400);
      // code is burned even on redirect mismatch
      const replay = await tokenRequest(base, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: idp.config.clientId,
        client_secret: idp.config.clientSecret,
        code_verifier: verifier,
      });
      expect(replay.status).toBe(400);
    } finally {
      await idp.close();
    }
  });

  it("rejects PKCE when the stored challenge length differs from the verifier hash", async () => {
    const { idp, base, redirectUri } = await listenIdp();
    try {
      const url = new URL(`${base}/authorize`);
      url.searchParams.set("client_id", idp.config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", "short");
      url.searchParams.set("code_challenge_method", "S256");
      const authRes = await fetch(url, { redirect: "manual" });
      const location = authRes.headers.get("location");
      const code = location ? new URL(location).searchParams.get("code") : null;
      if (!code) throw new Error("no code");

      const res = await tokenRequest(base, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: idp.config.clientId,
        client_secret: idp.config.clientSecret,
        code_verifier: randomBytes(32).toString("base64url"),
      });
      expect(res.status).toBe(400);
      const body = overlapCast(await res.json());
      expect(body.error_description).toBe("PKCE verification failed");
    } finally {
      await idp.close();
    }
  });

  it("supports the refresh_token grant and rejects unsupported grant types", async () => {
    const { idp, base } = await listenIdp();
    try {
      const refresh = await tokenRequest(base, {
        grant_type: "refresh_token",
        refresh_token: "mock-refresh-x",
        client_id: idp.config.clientId,
        client_secret: idp.config.clientSecret,
      });
      expect(refresh.status).toBe(200);
      const tokens = overlapCast(await refresh.json());
      expect(tokens.scope).toBe("openid profile email");
      expect(decodeJwt(tokens.id_token).nonce).toBeUndefined();

      const unsupported = await tokenRequest(base, {
        grant_type: "password",
        client_id: idp.config.clientId,
        client_secret: idp.config.clientSecret,
      });
      expect(unsupported.status).toBe(400);
      expect(overlapCast(await unsupported.json()).error).toBe(
        "unsupported_grant_type",
      );
    } finally {
      await idp.close();
    }
  });

  it("authenticates /token via HTTP Basic and rejects bad credentials", async () => {
    const { idp, base, redirectUri } = await listenIdp();
    try {
      const basic = (user: string, pass: string | null) =>
        `Basic ${Buffer.from(pass === null ? user : `${user}:${pass}`).toString("base64")}`;

      const { code, verifier } = await getCode(base, idp, redirectUri);
      if (!code) throw new Error("no code");
      const ok = await tokenRequest(
        base,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        },
        {
          authorization: basic(idp.config.clientId, idp.config.clientSecret),
        },
      );
      expect(ok.status).toBe(200);

      const wrongSecret = await tokenRequest(
        base,
        { grant_type: "refresh_token", refresh_token: "r" },
        { authorization: basic(idp.config.clientId, "wrong") },
      );
      expect(wrongSecret.status).toBe(401);

      const noColon = await tokenRequest(
        base,
        { grant_type: "refresh_token", refresh_token: "r" },
        { authorization: basic(idp.config.clientId, null) },
      );
      expect(noColon.status).toBe(401);

      const notBasic = await tokenRequest(
        base,
        { grant_type: "refresh_token", refresh_token: "r" },
        { authorization: "Bearer abc" },
      );
      expect(notBasic.status).toBe(401);

      const wrongBodySecret = await tokenRequest(base, {
        grant_type: "refresh_token",
        refresh_token: "r",
        client_id: idp.config.clientId,
        client_secret: "wrong",
      });
      expect(wrongBodySecret.status).toBe(401);
    } finally {
      await idp.close();
    }
  });

  it("serves userinfo, health, and a 404 for unknown paths", async () => {
    const { idp, base } = await listenIdp();
    try {
      const noAuth = await fetch(`${base}/userinfo`);
      expect(noAuth.status).toBe(401);

      const withAuth = await fetch(`${base}/userinfo`, {
        headers: { authorization: "Bearer mock-access-1" },
      });
      expect(withAuth.status).toBe(200);
      const info = overlapCast(await withAuth.json());
      expect(info.sub).toBe(idp.config.testUser.sub);
      expect(info.email).toBe(idp.config.testUser.email);
      expect(info.name).toBe(idp.config.testUser.name);

      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      const healthBody = overlapCast(await health.json());
      expect(healthBody.ok).toBe(true);
      expect(healthBody.issuer).toBe(base);
      expect(health.headers.get("strict-transport-security")).toBeNull();

      const missing = await fetch(`${base}/nope`);
      expect(missing.status).toBe(404);
      expect(overlapCast(await missing.json()).error).toBe("not_found");
    } finally {
      await idp.close();
    }
  });

  it("adds an HSTS header when the issuer is https", async () => {
    const { idp, base } = await listenIdp();
    try {
      idp.config.issuer = "https://idp.example.com";
      const res = await fetch(`${base}/health`);
      expect(res.headers.get("strict-transport-security")).toBe(
        "max-age=63072000; includeSubDomains",
      );
    } finally {
      await idp.close();
    }
  });

  it("listen() resolves the issuer and rejects non-loopback hosts", async () => {
    const idp = await createMockUpstreamIdp({
      host: "127.0.0.1",
      port: overlapCast(0),
      issuer: "http://127.0.0.1:0",
    });
    const issuer = await idp.listen();
    expect(issuer).toBe("http://127.0.0.1:0");
    await idp.close();

    const publicIdp = await createMockUpstreamIdp(
      overlapCast({
        host: "0.0.0.0",
        env: undefined,
      }),
    );
    await expect(publicIdp.listen()).rejects.toThrow(/not loopback/);
  });

  it("close() rejects when the server was never started", async () => {
    const idp = await createMockUpstreamIdp({
      host: "127.0.0.1",
      port: overlapCast(0),
      issuer: "http://127.0.0.1:0",
    });
    await expect(idp.close()).rejects.toThrow();
  });

  it("origin-profile clients: CORS token exchange, pairwise_sub, no secret", async () => {
    const { idp, base } = await listenIdp();
    try {
      const origin = "http://127.0.0.1:4101";
      const clientId = `origin:${origin}`;
      const redirectUri = `${origin}/opensesame/callback`;
      const verifier = randomBytes(32).toString("base64url");
      const url = new URL(`${base}/authorize`);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", s256(verifier));
      url.searchParams.set("code_challenge_method", "S256");
      const auth = await fetch(url, { redirect: "manual" });
      expect(auth.status).toBe(302);
      const code = new URL(auth.headers.get("location") ?? "").searchParams.get(
        "code",
      );
      expect(code).toBeTruthy();

      const preflight = await fetch(`${base}/token`, {
        method: "OPTIONS",
        headers: { origin },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);

      const denied = await tokenRequest(
        base,
        {
          grant_type: "authorization_code",
          code: code ?? "",
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        },
        { origin: "http://127.0.0.1:4102" },
      );
      expect(denied.status).toBe(403);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
      expect(await denied.json()).toMatchObject({
        error: "unauthorized_client",
        error_description: "origin_cors_denied",
      });

      const tokenRes = await tokenRequest(
        base,
        {
          grant_type: "authorization_code",
          code: code ?? "",
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        },
        { origin },
      );
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.headers.get("access-control-allow-origin")).toBe(origin);
      const tokens = overlapCast(await tokenRes.json());
      const payload = overlapCast(decodeJwt(tokens.id_token));
      expect(payload.sub).not.toBe(idp.config.testUser.sub);
      expect(payload.pairwise_sub).toBe(payload.sub);
      expect(payload.origin).toBe(origin);

      const otherOrigin = "http://127.0.0.1:4102";
      const otherClient = `origin:${otherOrigin}`;
      const otherRedirect = `${otherOrigin}/opensesame/callback`;
      const urlB = new URL(`${base}/authorize`);
      urlB.searchParams.set("client_id", otherClient);
      urlB.searchParams.set("redirect_uri", otherRedirect);
      urlB.searchParams.set("response_type", "code");
      urlB.searchParams.set("code_challenge", s256(verifier));
      urlB.searchParams.set("code_challenge_method", "S256");
      const authB = await fetch(urlB, { redirect: "manual" });
      const codeB = new URL(
        authB.headers.get("location") ?? "",
      ).searchParams.get("code");
      const tokenB = await tokenRequest(
        base,
        {
          grant_type: "authorization_code",
          code: codeB ?? "",
          redirect_uri: otherRedirect,
          client_id: otherClient,
          code_verifier: verifier,
        },
        { origin: otherOrigin },
      );
      const payloadB = overlapCast(
        decodeJwt(overlapCast(await tokenB.json()).id_token),
      );
      expect(payloadB.sub).not.toBe(payload.sub);
    } finally {
      await idp.close();
    }
  });

  it("rejects an origin client whose redirect is not on that origin", async () => {
    const { idp, base } = await listenIdp();
    try {
      const url = new URL(`${base}/authorize`);
      url.searchParams.set("client_id", "origin:http://127.0.0.1:4101");
      url.searchParams.set(
        "redirect_uri",
        "http://127.0.0.1:4102/opensesame/callback",
      );
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", s256("v"));
      url.searchParams.set("code_challenge_method", "S256");
      const res = await fetch(url, { redirect: "manual" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
    } finally {
      await idp.close();
    }
  });
});
