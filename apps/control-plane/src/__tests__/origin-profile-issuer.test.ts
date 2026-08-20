import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { startServer } from "../server.js";

type Started = Awaited<ReturnType<typeof startServer>>;

const ORIGIN = "http://127.0.0.1:4101";
const CLIENT_ID = `origin:${ORIGIN}`;
const REDIRECT_URI = `${ORIGIN}/opensesame/callback`;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authUrl(port: number, challenge: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid",
    state: "s-1",
    nonce: "n-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `http://127.0.0.1:${port}/auth?${params.toString()}`;
}

async function startOriginServer(enabled: boolean): Promise<Started> {
  const { startServer: start } = await import("../server.js");
  return start({
    config: {
      host: "127.0.0.1",
      port: 0,
      publicUrl: "http://127.0.0.1:0",
      issuer: "http://127.0.0.1:0",
    },
    processEnv: {
      ...process.env,
      OPENSESAME_ORIGIN_CLIENTS_ENABLED: enabled ? "true" : "false",
    },
  });
}

async function stop(started: Started): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    started.server.close((err) => (err ? reject(err) : resolve()));
  });
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("not a jwt");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("origin-profile issuer (ADR 0050 slice 3a)", () => {
  it("auto-admits an origin client on /auth and begins an interaction when the flag is on", async () => {
    const started = await startOriginServer(true);
    try {
      const { challenge } = pkce();
      const res = await fetch(authUrl(started.port, challenge), {
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toMatch(/^\/interaction\//);

      // Auto-admission persisted the fixed public-client profile (F2/F4).
      const record = await started.ctx.oauth.clientStore.findById(CLIENT_ID);
      expect(record).toMatchObject({
        id: CLIENT_ID,
        admissionMode: "origin_profile",
        origin: ORIGIN,
        ownershipStatus: "unclaimed",
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        allowedScopes: ["openid"],
        redirectUris: [REDIRECT_URI],
        state: "active",
      });

      // The persisted origin is now the exact CORS origin for /token.
      const preflight = await fetch(`http://127.0.0.1:${started.port}/token`, {
        method: "OPTIONS",
        headers: { origin: ORIGIN },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(preflight.headers.get("vary")).toContain("Origin");
    } finally {
      await stop(started);
    }
  });

  it("rejects origin client_ids on /auth when the flag is off", async () => {
    const started = await startOriginServer(false);
    try {
      const { challenge } = pkce();
      const res = await fetch(authUrl(started.port, challenge), {
        redirect: "manual",
      });
      expect(res.status).toBe(400);
      expect(
        await started.ctx.oauth.clientStore.findById(CLIENT_ID),
      ).toBeUndefined();

      // Nothing persisted: no CORS allowance either.
      const preflight = await fetch(`http://127.0.0.1:${started.port}/token`, {
        method: "OPTIONS",
        headers: { origin: ORIGIN },
      });
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await stop(started);
    }
  });

  it("R1: /token OPTIONS from a non-persisted origin gets no Access-Control-Allow-Origin", async () => {
    const started = await startOriginServer(true);
    try {
      const res = await fetch(`http://127.0.0.1:${started.port}/token`, {
        method: "OPTIONS",
        headers: { origin: "https://never-admitted.example" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("vary")).toContain("Origin");
      expect(res.status).toBe(403);

      // The probe must not have inserted a client row (F2 lookup-only).
      expect(
        await started.ctx.oauth.clientStore.findById(
          "origin:https://never-admitted.example",
        ),
      ).toBeUndefined();
    } finally {
      await stop(started);
    }
  });

  it("R2: /token POST with a mismatched or missing Origin is 403 origin_cors_denied and never reaches oidc-provider", async () => {
    const started = await startOriginServer(true);
    try {
      const { challenge } = pkce();
      const admit = await fetch(authUrl(started.port, challenge), {
        redirect: "manual",
      });
      expect(admit.status).toBe(303);

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: "any-code",
        redirect_uri: REDIRECT_URI,
        code_verifier: "any-verifier",
      });

      const mismatched = await fetch(`http://127.0.0.1:${started.port}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
        },
        body,
      });
      expect(mismatched.status).toBe(403);
      expect(mismatched.headers.get("access-control-allow-origin")).toBeNull();
      expect(await mismatched.json()).toEqual({
        error: "unauthorized_client",
        error_description: "origin_cors_denied",
      });

      const missing = await fetch(`http://127.0.0.1:${started.port}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(missing.status).toBe(403);
      expect(await missing.json()).toEqual({
        error: "unauthorized_client",
        error_description: "origin_cors_denied",
      });
    } finally {
      await stop(started);
    }
  });

  it("does not CORS-restrict pre_registered clients (server-to-server token calls carry no Origin)", async () => {
    const started = await startOriginServer(true);
    try {
      // Register a pre_registered client through the public API.
      const provisional = await started.app.request(
        "/v1/principals/provisional",
        {
          method: "POST",
        },
      );
      expect(provisional.status).toBe(201);
      const { accessToken } = (await provisional.json()) as {
        accessToken: string;
      };
      const linked = await started.app.request(
        "/v1/principals/link-identities",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "oidc",
            issuer: "https://mock.example",
            subject: "pre-registered-owner",
            assurance: "verified",
          }),
        },
      );
      expect(linked.status).toBe(201);

      const registered = await started.app.request("/v1/oauth/clients", {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          displayName: "Server RP",
          redirectUris: ["http://127.0.0.1:5173/callback"],
          sectorIdentifier: "https://server-rp.example",
        }),
      });
      expect(registered.status).toBe(201);
      const client = (await registered.json()) as { id: string };

      // No Origin header: the CORS gate must not engage, and the registered
      // client must resolve through the store into oidc-provider (an unknown
      // client would answer invalid_client instead of invalid_grant).
      const tokenRes = await fetch(`http://127.0.0.1:${started.port}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.id,
          code: "bogus-code",
          redirect_uri: "http://127.0.0.1:5173/callback",
          code_verifier: "bogus-verifier",
        }),
      });
      expect(tokenRes.status).toBe(400);
      const body = (await tokenRes.json()) as { error: string };
      expect(body.error).toBe("invalid_grant");
    } finally {
      await stop(started);
    }
  });

  it("R3: code exchange from the exact persisted origin succeeds and yields a truthful pairwise sub", async () => {
    const started = await startOriginServer(true);
    try {
      const { verifier, challenge } = pkce();
      const admit = await fetch(authUrl(started.port, challenge), {
        redirect: "manual",
      });
      expect(admit.status).toBe(303);

      // Mint an authorization code for the admitted client (the interaction
      // UI that would issue it in production is slice 3b).
      const provider = started.ctx.oauth.provider;
      const client = await provider.Client.find(CLIENT_ID);
      expect(client).toBeDefined();
      const accountId = "prn_static_site_user";
      const grant = new provider.Grant({ accountId, clientId: CLIENT_ID });
      grant.addOIDCScope("openid");
      await grant.save();
      const code = new provider.AuthorizationCode({
        client,
        accountId,
        redirectUri: REDIRECT_URI,
        scope: "openid",
        authTime: Math.floor(Date.now() / 1000),
        nonce: "n-1",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        grantId: grant.jti,
      } as never);
      const codeValue = await code.save();

      const tokenRes = await fetch(`http://127.0.0.1:${started.port}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: codeValue,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(tokenRes.headers.get("vary")).toContain("Origin");

      const tokens = (await tokenRes.json()) as {
        id_token: string;
        access_token: string;
        token_type: string;
      };
      const payload = decodeJwtPayload(tokens.id_token);
      expect(payload.aud).toBe(CLIENT_ID);
      expect(payload.nonce).toBe("n-1");
      expect(typeof payload.sub).toBe("string");
      // Pairwise: the sub is not the account id, and it is the truthful
      // persisted mapping for (account, sector).
      expect(payload.sub).not.toBe(accountId);
      const sector = (client as unknown as { sectorIdentifier: string })
        .sectorIdentifier;
      const mapping = await started.ctx.oauth.pairwiseStore.find(
        accountId,
        sector,
      );
      expect(mapping).toBeDefined();
      expect(payload.sub).toBe(mapping?.subject);
    } finally {
      await stop(started);
    }
  });

  it("R4: authorization without a PKCE challenge does not issue a code", async () => {
    const started = await startOriginServer(true);
    try {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid",
        state: "s-1",
        nonce: "n-1",
      });
      const res = await fetch(
        `http://127.0.0.1:${started.port}/auth?${params.toString()}`,
        { redirect: "manual" },
      );
      const location = res.headers.get("location") ?? "";
      expect(location.includes("code=")).toBe(false);
      if (res.status >= 400) {
        expect(res.status).toBeLessThan(500);
      }
    } finally {
      await stop(started);
    }
  });

  it("R5: token exchange without a code_verifier is refused", async () => {
    const started = await startOriginServer(true);
    try {
      const { verifier, challenge } = pkce();
      const admit = await fetch(authUrl(started.port, challenge), {
        redirect: "manual",
      });
      expect(admit.status).toBe(303);
      const provider = started.ctx.oauth.provider;
      const client = await provider.Client.find(CLIENT_ID);
      const accountId = "prn_static_site_user";
      const grant = new provider.Grant({ accountId, clientId: CLIENT_ID });
      grant.addOIDCScope("openid");
      await grant.save();
      const code = new provider.AuthorizationCode({
        client,
        accountId,
        redirectUri: REDIRECT_URI,
        scope: "openid",
        authTime: Math.floor(Date.now() / 1000),
        nonce: "n-1",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        grantId: grant.jti,
      } as never);
      const codeValue = await code.save();

      const tokenRes = await fetch(`http://127.0.0.1:${started.port}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: codeValue,
          redirect_uri: REDIRECT_URI,
        }),
      });
      expect(tokenRes.ok).toBe(false);
      const body = (await tokenRes.json()) as { error?: string };
      expect(body.error).toBeTruthy();
      expect(verifier.length).toBeGreaterThan(0);
    } finally {
      await stop(started);
    }
  });

  it("R6: authorization with PKCE method plain does not issue a code", async () => {
    const started = await startOriginServer(true);
    try {
      const { verifier } = pkce();
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid",
        state: "s-1",
        nonce: "n-1",
        code_challenge: verifier,
        code_challenge_method: "plain",
      });
      const res = await fetch(
        `http://127.0.0.1:${started.port}/auth?${params.toString()}`,
        { redirect: "manual" },
      );
      const location = res.headers.get("location") ?? "";
      expect(location.includes("code=")).toBe(false);
      if (res.status >= 400) {
        expect(res.status).toBeLessThan(500);
      }
    } finally {
      await stop(started);
    }
  });

  it("R9: offline_access is not admitted on an origin-profile client", async () => {
    const started = await startOriginServer(true);
    try {
      const { challenge } = pkce();
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "openid offline_access",
        state: "s-1",
        nonce: "n-1",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const res = await fetch(
        `http://127.0.0.1:${started.port}/auth?${params.toString()}`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(303);
      const record = await started.ctx.oauth.clientStore.findById(CLIENT_ID);
      expect(record?.allowedScopes).toEqual(["openid"]);
      expect(record?.grantTypes).toEqual(["authorization_code"]);
      expect(record?.tokenEndpointAuthMethod).toBe("none");
    } finally {
      await stop(started);
    }
  });

  it("R10: pairwise subs differ across port-distinct origins", async () => {
    const started = await startOriginServer(true);
    try {
      const originB = "http://127.0.0.1:4102";
      const clientB = `origin:${originB}`;
      const redirectB = `${originB}/opensesame/callback`;
      const accountId = "prn_static_site_user";

      async function mintSub(
        origin: string,
        clientId: string,
        redirectUri: string,
      ): Promise<string> {
        const { verifier, challenge } = pkce();
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "openid",
          state: "s-1",
          nonce: "n-1",
          code_challenge: challenge,
          code_challenge_method: "S256",
        });
        const admit = await fetch(
          `http://127.0.0.1:${started.port}/auth?${params.toString()}`,
          { redirect: "manual" },
        );
        expect(admit.status).toBe(303);
        const provider = started.ctx.oauth.provider;
        const client = await provider.Client.find(clientId);
        const grant = new provider.Grant({ accountId, clientId });
        grant.addOIDCScope("openid");
        await grant.save();
        const code = new provider.AuthorizationCode({
          client,
          accountId,
          redirectUri,
          scope: "openid",
          authTime: Math.floor(Date.now() / 1000),
          nonce: "n-1",
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          grantId: grant.jti,
        } as never);
        const codeValue = await code.save();
        const tokenRes = await fetch(`http://127.0.0.1:${started.port}/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code: codeValue,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          }),
        });
        expect(tokenRes.status).toBe(200);
        const tokens = (await tokenRes.json()) as { id_token: string };
        const payload = decodeJwtPayload(tokens.id_token);
        expect(typeof payload.sub).toBe("string");
        return payload.sub as string;
      }

      const subA = await mintSub(ORIGIN, CLIENT_ID, REDIRECT_URI);
      const subB = await mintSub(originB, clientB, redirectB);
      expect(subA).not.toBe(subB);
      expect(subA).not.toBe(accountId);
      expect(subB).not.toBe(accountId);
    } finally {
      await stop(started);
    }
  });

  it("R12: discovery advertises authorization, token, and jwks", async () => {
    const started = await startOriginServer(true);
    try {
      const res = await fetch(
        `http://127.0.0.1:${started.port}/.well-known/openid-configuration`,
      );
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
        jwks_uri: string;
      };
      expect(doc.authorization_endpoint).toContain("/auth");
      expect(doc.token_endpoint).toContain("/token");
      expect(doc.jwks_uri).toMatch(/jwks/i);
    } finally {
      await stop(started);
    }
  });
});
