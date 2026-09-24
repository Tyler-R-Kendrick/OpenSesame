import { overlapCast } from "@opensesame/os-domain";
import {
  STATIC_SELF_ISSUED_ISSUER,
  buildSelfIssuedIdToken,
  exportPublicEcP256Jwk,
} from "@opensesame/siop-v2";
import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

const AUDIENCE = "https://id.example/siop-bridge";

type App = ReturnType<typeof createControlPlane>["app"];

async function es256Pair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportPublicEcP256Jwk(publicKey);
  return { privateKey, publicJwk };
}

async function provisional(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

type SiopChallengeBody = {
  audience: string;
  expectedIssuer?: string;
};

type SiopLinkBody = {
  challengeId: string;
  idToken: string;
  email?: string;
  name?: string;
};

type SiopRouteBody = SiopChallengeBody | SiopLinkBody;

function bearerJson(token: string, body: SiopRouteBody) {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  } satisfies RequestInit;
}

describe("POST /v1/siop/challenges and /link", () => {
  it("requires authentication", async () => {
    const { app } = createControlPlane();
    const res = await app.request("/v1/siop/challenges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audience: AUDIENCE }),
    });
    expect(res.status).toBe(401);
  });

  it("links through the HTTP surface and persists external_identities", async () => {
    const { app } = createControlPlane();
    const session = await provisional(app);
    const challengeRes = await app.request(
      "/v1/siop/challenges",
      bearerJson(session.accessToken, {
        audience: AUDIENCE,
        expectedIssuer: STATIC_SELF_ISSUED_ISSUER,
      }),
    );
    expect(challengeRes.status).toBe(201);
    const challenge = overlapCast(await challengeRes.json());
    const { privateKey, publicJwk } = await es256Pair();
    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience: AUDIENCE,
      nonce: challenge.nonce,
      publicJwk,
      signingKey: privateKey,
    });
    const linkRes = await app.request(
      "/v1/siop/link",
      bearerJson(session.accessToken, {
        challengeId: challenge.challengeId,
        idToken,
      }),
    );
    expect(linkRes.status).toBe(201);
    const linked = overlapCast(await linkRes.json());
    expect(linked).toMatchObject({
      principalId: session.principalId,
      alreadyLinked: false,
      link: { siopSub: linked.link.jwkThumbprint },
    });

    const me = await app.request("/v1/principals/identities", {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.status).toBe(200);
    const body = overlapCast(await me.json());
    expect(body.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "siop",
          issuer: STATIC_SELF_ISSUED_ISSUER,
          subject: linked.link.siopSub,
        }),
      ]),
    );
  });

  it("returns 400 when the caller offers email for linking", async () => {
    const { app } = createControlPlane();
    const session = await provisional(app);
    const challengeRes = await app.request(
      "/v1/siop/challenges",
      bearerJson(session.accessToken, { audience: AUDIENCE }),
    );
    const challenge = overlapCast(await challengeRes.json());
    const linkRes = await app.request(
      "/v1/siop/link",
      bearerJson(session.accessToken, {
        challengeId: challenge.challengeId,
        idToken: "ignored",
        email: "a@example.com",
      }),
    );
    expect(linkRes.status).toBe(400);
    expect(overlapCast(await linkRes.json())).toMatchObject({
      error: "email_link_refused",
    });
  });

  it("ignores a name field and does not treat it as email linking", async () => {
    const { app } = createControlPlane();
    const session = await provisional(app);
    const challengeRes = await app.request(
      "/v1/siop/challenges",
      bearerJson(session.accessToken, { audience: AUDIENCE }),
    );
    const challenge = overlapCast(await challengeRes.json());
    const { privateKey, publicJwk } = await es256Pair();
    const idToken = await buildSelfIssuedIdToken({
      profile: { kind: "static" },
      audience: AUDIENCE,
      nonce: challenge.nonce,
      publicJwk,
      signingKey: privateKey,
    });
    const linkRes = await app.request(
      "/v1/siop/link",
      bearerJson(session.accessToken, {
        challengeId: challenge.challengeId,
        idToken,
        name: "display-only",
      }),
    );
    expect(linkRes.status).toBe(201);
    expect(overlapCast(await linkRes.json())).not.toMatchObject({
      error: "email_link_refused",
    });
  });

  it("returns 400 for whitespace audience on challenge create", async () => {
    const { app } = createControlPlane();
    const session = await provisional(app);
    const res = await app.request(
      "/v1/siop/challenges",
      bearerJson(session.accessToken, { audience: "   " }),
    );
    expect(res.status).toBe(400);
    expect(overlapCast(await res.json())).toMatchObject({
      error: "invalid_request",
    });
  });
});
