import { createHash, randomBytes } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { type ReferenceIdp, startReferenceIdp } from "./testkit.js";

/**
 * Protocol conformance for the reference IdP's GitHub-shaped OAuth2 surface.
 *
 * The three quirks under test are the reason the generic OAuth2 leg cannot be
 * written against an OIDC mental model: form-encoded-by-default responses,
 * errors delivered with HTTP 200, and a numeric subject.
 */

const REDIRECT_URI = "http://127.0.0.1:4801/interaction/u1/federated/callback";

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function authorizeCode(
  idp: ReferenceIdp,
  challenge?: string,
): Promise<string> {
  const url = new URL(idp.oauth2.authorizeUrl);
  url.searchParams.set("client_id", idp.oauth2.clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", "oauth2-state");
  if (challenge !== undefined) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.searchParams.get("state")).toBe("oauth2-state");
  return location.searchParams.get("code") ?? "";
}

function tokenRequest(
  idp: ReferenceIdp,
  body: URLSearchParams,
  accept?: string,
): Promise<Response> {
  return fetch(idp.oauth2.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(accept !== undefined ? { accept } : undefined),
    },
    body,
  });
}

describe("reference IdP — OAuth2 (GitHub-shaped)", () => {
  it("returns a form-encoded token response unless Accept asks for JSON", async () => {
    const idp = await startReferenceIdp({ protocol: "oauth2" });
    try {
      const formBody = new URLSearchParams({
        grant_type: "authorization_code",
        code: await authorizeCode(idp),
        redirect_uri: REDIRECT_URI,
        client_id: idp.oauth2.clientId,
        client_secret: idp.oauth2.clientSecret,
      });
      const formRes = await tokenRequest(idp, formBody);
      expect(formRes.status).toBe(200);
      expect(formRes.headers.get("content-type")).toContain(
        "application/x-www-form-urlencoded",
      );
      const parsed = new URLSearchParams(await formRes.text());
      expect(parsed.get("access_token")).toMatch(/^gho_[0-9a-f]{40}$/);
      expect(parsed.get("token_type")).toBe("bearer");
      expect(parsed.get("scope")).toBe("read:user");
      // GitHub OAuth apps issue no refresh token; a leg that expects one is wrong.
      expect(parsed.get("refresh_token")).toBeNull();

      const jsonRes = await tokenRequest(
        idp,
        new URLSearchParams({
          grant_type: "authorization_code",
          code: await authorizeCode(idp),
          redirect_uri: REDIRECT_URI,
          client_id: idp.oauth2.clientId,
          client_secret: idp.oauth2.clientSecret,
        }),
        "application/json",
      );
      expect(jsonRes.headers.get("content-type")).toContain("application/json");
      const tokens = overlapCast(await jsonRes.json());
      expect(tokens.access_token).toMatch(/^gho_/);
      expect(tokens.refresh_token).toBeUndefined();
    } finally {
      await idp.close();
    }
  });

  it("delivers protocol errors as HTTP 200 with an error key", async () => {
    const idp = await startReferenceIdp({ protocol: "oauth2" });
    try {
      const badCode = await tokenRequest(
        idp,
        new URLSearchParams({
          grant_type: "authorization_code",
          code: "not-a-real-code",
          redirect_uri: REDIRECT_URI,
          client_id: idp.oauth2.clientId,
          client_secret: idp.oauth2.clientSecret,
        }),
        "application/json",
      );
      expect(badCode.status).toBe(200);
      expect(overlapCast(await badCode.json()).error).toBe(
        "bad_verification_code",
      );

      const badSecret = await tokenRequest(
        idp,
        new URLSearchParams({
          grant_type: "authorization_code",
          code: await authorizeCode(idp),
          redirect_uri: REDIRECT_URI,
          client_id: idp.oauth2.clientId,
          client_secret: "wrong",
        }),
      );
      expect(badSecret.status).toBe(200);
      expect(new URLSearchParams(await badSecret.text()).get("error")).toBe(
        "incorrect_client_credentials",
      );

      const refresh = await tokenRequest(
        idp,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "whatever",
          client_id: idp.oauth2.clientId,
          client_secret: idp.oauth2.clientSecret,
        }),
        "application/json",
      );
      expect(refresh.status).toBe(200);
      expect(overlapCast(await refresh.json()).error).toBe(
        "unsupported_grant_type",
      );
    } finally {
      await idp.close();
    }
  });

  it("burns the code on first use and rejects a mismatched redirect_uri", async () => {
    const idp = await startReferenceIdp({ protocol: "oauth2" });
    try {
      const code = await authorizeCode(idp);
      const first = await tokenRequest(
        idp,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: idp.oauth2.clientId,
          client_secret: idp.oauth2.clientSecret,
        }),
        "application/json",
      );
      expect(overlapCast(await first.json()).access_token).toBeTruthy();

      const replay = await tokenRequest(
        idp,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: idp.oauth2.clientId,
          client_secret: idp.oauth2.clientSecret,
        }),
        "application/json",
      );
      expect(overlapCast(await replay.json()).error).toBe(
        "bad_verification_code",
      );

      const mismatched = await tokenRequest(
        idp,
        new URLSearchParams({
          grant_type: "authorization_code",
          code: await authorizeCode(idp),
          redirect_uri: "http://127.0.0.1:4801/elsewhere",
          client_id: idp.oauth2.clientId,
          client_secret: idp.oauth2.clientSecret,
        }),
        "application/json",
      );
      expect(overlapCast(await mismatched.json()).error).toBe(
        "redirect_uri_mismatch",
      );
    } finally {
      await idp.close();
    }
  });

  it("verifies a PKCE verifier when the authorization carried a challenge", async () => {
    const idp = await startReferenceIdp({ protocol: "oauth2" });
    try {
      const verifier = randomBytes(32).toString("base64url");
      const code = await authorizeCode(idp, s256(verifier));
      const wrong = await tokenRequest(
        idp,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: idp.oauth2.clientId,
          client_secret: idp.oauth2.clientSecret,
          code_verifier: randomBytes(32).toString("base64url"),
        }),
        "application/json",
      );
      expect(overlapCast(await wrong.json()).error).toBe(
        "bad_verification_code",
      );

      const accepted = await tokenRequest(
        idp,
        new URLSearchParams({
          grant_type: "authorization_code",
          code: await authorizeCode(idp, s256(verifier)),
          redirect_uri: REDIRECT_URI,
          client_id: idp.oauth2.clientId,
          client_secret: idp.oauth2.clientSecret,
          code_verifier: verifier,
        }),
        "application/json",
      );
      expect(overlapCast(await accepted.json()).access_token).toBeTruthy();
    } finally {
      await idp.close();
    }
  });

  it("serves a profile whose id is numeric and whose login is not the subject", async () => {
    const idp = await startReferenceIdp({ protocol: "oauth2" });
    try {
      const unauthenticated = await fetch(idp.oauth2.userinfoUrl);
      expect(unauthenticated.status).toBe(401);
      expect(overlapCast(await unauthenticated.json()).message).toBe(
        "Bad credentials",
      );

      const tokenRes = await tokenRequest(
        idp,
        new URLSearchParams({
          grant_type: "authorization_code",
          code: await authorizeCode(idp),
          redirect_uri: REDIRECT_URI,
          client_id: idp.oauth2.clientId,
          client_secret: idp.oauth2.clientSecret,
        }),
        "application/json",
      );
      const accessToken = overlapCast(await tokenRes.json()).access_token;

      const profile = await fetch(idp.oauth2.userinfoUrl, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(profile.status).toBe(200);
      const body = overlapCast(await profile.json());
      expect(body.id).toBe(idp.oauth2.userId);
      expect(Number.isInteger(body.id)).toBe(true);
      expect(body.login).toBe(idp.oauth2.login);
      // `login` is renameable — binding a subject to it is an account-takeover
      // path, so the two must be observably different values.
      expect(String(body.id)).not.toBe(body.login);

      const asToken = await fetch(idp.oauth2.userinfoUrl, {
        headers: { authorization: `token ${accessToken}` },
      });
      expect(asToken.status).toBe(200);
    } finally {
      await idp.close();
    }
  });

  it("publishes authorization-server metadata as its protocol metadata", async () => {
    const idp = await startReferenceIdp({ protocol: "oauth2" });
    try {
      expect(idp.metadataUrl).toBe(idp.oauth2.metadataUrl);
      const meta = overlapCast(await (await fetch(idp.metadataUrl)).json());
      expect(meta.token_endpoint).toBe(idp.oauth2.tokenUrl);
      expect(meta.grant_types_supported).toEqual(["authorization_code"]);
      // No id_token anywhere: that is what forces the generic OAuth2 leg.
      expect(meta.id_token_signing_alg_values_supported).toBeUndefined();
    } finally {
      await idp.close();
    }
  });

  it("refuses an unknown client and an unregistered redirect target", async () => {
    const idp = await startReferenceIdp({ protocol: "oauth2" });
    try {
      const unknownClient = new URL(idp.oauth2.authorizeUrl);
      unknownClient.searchParams.set("client_id", "someone-else");
      unknownClient.searchParams.set("redirect_uri", REDIRECT_URI);
      const res = await fetch(unknownClient, { redirect: "manual" });
      expect(res.status).toBe(400);

      const foreignRedirect = new URL(idp.oauth2.authorizeUrl);
      foreignRedirect.searchParams.set("client_id", idp.oauth2.clientId);
      foreignRedirect.searchParams.set(
        "redirect_uri",
        "https://evil.example/callback",
      );
      const refused = await fetch(foreignRedirect, { redirect: "manual" });
      expect(refused.status).toBe(400);
      expect(overlapCast(await refused.json()).error).toBe(
        "redirect_uri_mismatch",
      );
    } finally {
      await idp.close();
    }
  });
});
