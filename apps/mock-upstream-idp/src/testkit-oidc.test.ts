import { createHash, randomBytes } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { type ReferenceIdp, startReferenceIdp } from "./testkit.js";

/**
 * Protocol conformance for the reference IdP's OIDC surface.
 *
 * Every assertion here is made against a real HTTP server over real
 * cryptography: the requests are the ones a relying party sends, and the
 * refusals are the ones a real IdP answers with.
 */

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface AuthorizeInput {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state?: string;
  nonce?: string;
  responseMode?: string;
}

function authorizeUrl(idp: ReferenceIdp, input: AuthorizeInput): URL {
  const url = new URL(`${idp.issuer}/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.state !== undefined) url.searchParams.set("state", input.state);
  if (input.nonce !== undefined) url.searchParams.set("nonce", input.nonce);
  if (input.responseMode !== undefined) {
    url.searchParams.set("response_mode", input.responseMode);
  }
  return url;
}

describe("reference IdP — OIDC", () => {
  it("advertises discovery at the port it actually bound", async () => {
    const idp = await startReferenceIdp();
    try {
      const res = await fetch(idp.metadataUrl);
      expect(res.status).toBe(200);
      const meta = overlapCast(await res.json());
      // A discovery document frozen at construction would still say ":0".
      expect(meta.issuer).toBe(idp.issuer);
      expect(meta.token_endpoint).toBe(`${idp.issuer}/token`);
      expect(meta.jwks_uri).toBe(`${idp.issuer}/jwks`);
      expect(meta.registration_endpoint).toBe(`${idp.issuer}/register`);
      expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
      expect(meta.response_modes_supported).toContain("form_post");
    } finally {
      await idp.close();
    }
  });

  it("enforces PKCE S256 and mints an id_token the published JWKS verifies", async () => {
    const idp = await startReferenceIdp({ subject: "ref-user-9" });
    try {
      const origin = "http://127.0.0.1:4711";
      const clientId = `origin:${origin}`;
      const redirectUri = `${origin}/opensesame/callback`;
      const verifier = randomBytes(32).toString("base64url");

      const noPkce = authorizeUrl(idp, {
        clientId,
        redirectUri,
        challenge: s256(verifier),
      });
      noPkce.searchParams.delete("code_challenge");
      const refused = await fetch(noPkce, { redirect: "manual" });
      expect(refused.status).toBe(400);
      expect(overlapCast(await refused.json()).error_description).toBe(
        "PKCE S256 required",
      );

      const auth = await fetch(
        authorizeUrl(idp, {
          clientId,
          redirectUri,
          challenge: s256(verifier),
          state: "st-1",
          nonce: "nonce-1",
        }),
        { redirect: "manual" },
      );
      expect(auth.status).toBe(302);
      const location = new URL(auth.headers.get("location") ?? "");
      expect(location.searchParams.get("state")).toBe("st-1");
      expect(idp.lastNonce()).toBe("nonce-1");
      const code = location.searchParams.get("code") ?? "";

      const wrongVerifier = await fetch(`${idp.issuer}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: randomBytes(32).toString("base64url"),
        }),
      });
      expect(wrongVerifier.status).toBe(400);

      const retryVerifier = randomBytes(32).toString("base64url");
      const auth2 = await fetch(
        authorizeUrl(idp, {
          clientId,
          redirectUri,
          challenge: s256(retryVerifier),
          nonce: "nonce-2",
        }),
        { redirect: "manual" },
      );
      const code2 = new URL(
        auth2.headers.get("location") ?? "",
      ).searchParams.get("code");

      const tokenRes = await fetch(`${idp.issuer}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code2 ?? "",
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: retryVerifier,
        }),
      });
      expect(tokenRes.status).toBe(200);
      const tokens = overlapCast(await tokenRes.json());

      const key = await importJWK(idp.publicJwk, "RS256");
      const { payload } = await jwtVerify(tokens.id_token, key, {
        issuer: idp.issuer,
        audience: clientId,
      });
      expect(payload.nonce).toBe("nonce-2");
      expect(payload.email_verified).toBe(true);
      expect(payload.pairwise_sub).toBe(payload.sub);
      expect(payload.sub).not.toBe("ref-user-9");
      expect(idp.tokenOriginSeen()).toBe(origin);
      expect(idp.tokenClientSeen().id).toBe(clientId);
      expect(idp.tokenClientSeen().secret).toBeUndefined();
    } finally {
      await idp.close();
    }
  });

  it("binds an origin-profile token request to a byte-equal Origin header", async () => {
    const idp = await startReferenceIdp();
    try {
      const origin = "http://127.0.0.1:4712";
      const clientId = `origin:${origin}`;
      const redirectUri = `${origin}/opensesame/callback`;
      const verifier = randomBytes(32).toString("base64url");
      const auth = await fetch(
        authorizeUrl(idp, {
          clientId,
          redirectUri,
          challenge: s256(verifier),
        }),
        { redirect: "manual" },
      );
      const code = new URL(auth.headers.get("location") ?? "").searchParams.get(
        "code",
      );

      const denied = await fetch(`${idp.issuer}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // One character of difference is enough.
          origin: `${origin}/`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code ?? "",
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        }),
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        error: "unauthorized_client",
        error_description: "origin_cors_denied",
      });
    } finally {
      await idp.close();
    }
  });

  it("answers form_post with a real self-posting form instead of a redirect", async () => {
    const idp = await startReferenceIdp({ formPost: true });
    try {
      const origin = "http://127.0.0.1:4713";
      const clientId = `origin:${origin}`;
      const redirectUri = `${origin}/opensesame/callback`;
      const res = await fetch(
        authorizeUrl(idp, {
          clientId,
          redirectUri,
          challenge: s256(randomBytes(32).toString("base64url")),
          state: "st-form",
        }),
        { redirect: "manual" },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain(`<form method="post" action="${redirectUri}"`);
      expect(html).toMatch(/name="code" value="code_[0-9a-f]{32}"/);
      expect(html).toContain('name="state" value="st-form"');
      // The browser submits it without a click; that is why the callback POST
      // is cross-site and carries no SameSite=Lax cookies.
      expect(html).toContain("document.forms[0].submit()");
      expect(html).not.toContain("location:");
    } finally {
      await idp.close();
    }
  });

  it("honours response_mode=form_post per request when not started in that mode", async () => {
    const idp = await startReferenceIdp();
    try {
      const origin = "http://127.0.0.1:4714";
      const res = await fetch(
        authorizeUrl(idp, {
          clientId: `origin:${origin}`,
          redirectUri: `${origin}/cb`,
          challenge: s256(randomBytes(32).toString("base64url")),
          responseMode: "form_post",
        }),
        { redirect: "manual" },
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<form method="post"');
    } finally {
      await idp.close();
    }
  });

  it("registers a client through RFC 7591 and then admits it", async () => {
    const idp = await startReferenceIdp();
    try {
      expect(idp.registrationEndpoint).toBe(`${idp.issuer}/register`);
      const redirectUri = "http://127.0.0.1:4715/callback";
      const registration = await fetch(`${idp.issuer}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          client_name: "byo-test",
          token_endpoint_auth_method: "client_secret_post",
        }),
      });
      expect(registration.status).toBe(201);
      const client = overlapCast(await registration.json());
      expect(client.client_id).toMatch(/^dcr-[0-9a-f]{24}$/);
      expect(client.client_secret_expires_at).toBe(0);
      expect(client.token_endpoint_auth_method).toBe("client_secret_post");

      const verifier = randomBytes(32).toString("base64url");
      const auth = await fetch(
        authorizeUrl(idp, {
          clientId: client.client_id,
          redirectUri,
          challenge: s256(verifier),
        }),
        { redirect: "manual" },
      );
      expect(auth.status).toBe(302);
      const code = new URL(auth.headers.get("location") ?? "").searchParams.get(
        "code",
      );

      const tokenRes = await fetch(`${idp.issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code ?? "",
          redirect_uri: redirectUri,
          client_id: client.client_id,
          client_secret: client.client_secret,
          code_verifier: verifier,
        }),
      });
      expect(tokenRes.status).toBe(200);
      const key = await importJWK(idp.publicJwk, "RS256");
      const { payload } = await jwtVerify(
        overlapCast(await tokenRes.json()).id_token,
        key,
        { issuer: idp.issuer, audience: client.client_id },
      );
      expect(payload.sub).toBeTruthy();

      const wrongRedirect = await fetch(
        authorizeUrl(idp, {
          clientId: client.client_id,
          redirectUri: "http://127.0.0.1:4715/elsewhere",
          challenge: s256(verifier),
        }),
        { redirect: "manual" },
      );
      expect(wrongRedirect.status).toBe(400);
      expect(overlapCast(await wrongRedirect.json()).error).toBe(
        "invalid_redirect_uri",
      );
    } finally {
      await idp.close();
    }
  });

  it("refuses malformed registration metadata", async () => {
    const idp = await startReferenceIdp();
    try {
      const cases = [
        { body: "not json", error: "invalid_client_metadata" },
        { body: JSON.stringify({}), error: "invalid_redirect_uri" },
        {
          body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }),
          error: "invalid_redirect_uri",
        },
        {
          body: JSON.stringify({
            redirect_uris: ["http://127.0.0.1:1/cb"],
            token_endpoint_auth_method: "private_key_jwt",
          }),
          error: "invalid_client_metadata",
        },
      ];
      for (const testCase of cases) {
        const res = await fetch(`${idp.issuer}/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: testCase.body,
        });
        expect(res.status).toBe(400);
        expect(overlapCast(await res.json()).error).toBe(testCase.error);
      }
    } finally {
      await idp.close();
    }
  });

  it("withholds the registration endpoint when registration is off", async () => {
    const idp = await startReferenceIdp({ registration: false });
    try {
      expect(idp.registrationEndpoint).toBeUndefined();
      const meta = overlapCast(await (await fetch(idp.metadataUrl)).json());
      expect(meta.registration_endpoint).toBeUndefined();
      const res = await fetch(`${idp.issuer}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:1/cb"] }),
      });
      expect(res.status).toBe(404);
    } finally {
      await idp.close();
    }
  });

  it("refuses a client that violates the configured client mode", async () => {
    const originOnly = await startReferenceIdp({
      clientMode: "origin_profile",
    });
    try {
      originOnly.setRedirectUris(["http://127.0.0.1:4716/cb"]);
      const res = await fetch(
        authorizeUrl(originOnly, {
          clientId: originOnly.clientId,
          redirectUri: "http://127.0.0.1:4716/cb",
          challenge: s256("v"),
        }),
        { redirect: "manual" },
      );
      expect(res.status).toBe(400);
      expect(overlapCast(await res.json()).error_description).toBe(
        "client mode origin_profile required",
      );
    } finally {
      await originOnly.close();
    }

    const confidentialOnly = await startReferenceIdp({
      clientMode: "confidential",
    });
    try {
      const origin = "http://127.0.0.1:4717";
      const res = await fetch(
        authorizeUrl(confidentialOnly, {
          clientId: `origin:${origin}`,
          redirectUri: `${origin}/cb`,
          challenge: s256("v"),
        }),
        { redirect: "manual" },
      );
      expect(res.status).toBe(400);
      expect(overlapCast(await res.json()).error_description).toBe(
        "client mode confidential required",
      );
    } finally {
      await confidentialOnly.close();
    }
  });

  it("completes the confidential leg for the seeded client", async () => {
    const idp = await startReferenceIdp();
    try {
      const redirectUri = "http://127.0.0.1:4718/callback";
      idp.setRedirectUris([redirectUri]);
      const verifier = randomBytes(32).toString("base64url");
      const auth = await fetch(
        authorizeUrl(idp, {
          clientId: idp.clientId,
          redirectUri,
          challenge: s256(verifier),
        }),
        { redirect: "manual" },
      );
      const code = new URL(auth.headers.get("location") ?? "").searchParams.get(
        "code",
      );

      const wrongSecret = await fetch(`${idp.issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code ?? "",
          redirect_uri: redirectUri,
          client_id: idp.clientId,
          client_secret: "not-the-secret",
          code_verifier: verifier,
        }),
      });
      expect(wrongSecret.status).toBe(401);
      expect(idp.tokenClientSeen().secret).toBe("not-the-secret");
    } finally {
      await idp.close();
    }
  });

  it("mints a real back-channel logout token, and a malformed one on demand", async () => {
    const idp = await startReferenceIdp();
    try {
      const key = await importJWK(idp.publicJwk, "RS256");
      const token = await idp.mintBackchannelLogoutToken("subject-42");
      const { payload, protectedHeader } = await jwtVerify(token, key, {
        issuer: idp.issuer,
        audience: idp.clientId,
      });
      expect(protectedHeader.alg).toBe("RS256");
      expect(payload.sub).toBe("subject-42");
      expect(payload.jti).toBeTruthy();
      expect(payload.events).toEqual({
        "http://schemas.openid.net/event/backchannel-logout": {},
      });
      // OIDC Back-Channel Logout 1.0 §2.4: a logout token MUST NOT carry nonce.
      expect(payload.nonce).toBeUndefined();

      const malformed = await idp.mintBackchannelLogoutToken("subject-42", {
        includeNonce: true,
      });
      const verified = await jwtVerify(malformed, key, { issuer: idp.issuer });
      expect(verified.payload.nonce).toBeTruthy();
    } finally {
      await idp.close();
    }
  });
});
