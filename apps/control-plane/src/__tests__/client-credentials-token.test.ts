import { type KeyObject, createSign, generateKeyPairSync } from "node:crypto";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { startServer } from "../server.js";
import { onFreePort } from "./free-port.js";

type Started = Awaited<ReturnType<typeof startServer>>;

function publicJwk(key: KeyObject): JsonObject {
  const jwk = overlapCast(key.export({ format: "jwk" }));
  jwk.kid = "cc-identity-1";
  jwk.use = "sig";
  jwk.alg = "RS256";
  jwk.d = undefined;
  jwk.p = undefined;
  jwk.q = undefined;
  jwk.dp = undefined;
  jwk.dq = undefined;
  jwk.qi = undefined;
  return jwk;
}

function signJwt(
  key: KeyObject,
  header: JsonObject,
  payload: JsonObject,
): string {
  const head = Buffer.from(JSON.stringify(header)).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${head}.${body}`;
  const sig = createSign("RSA-SHA256").update(data).sign(key, "base64url");
  return `${data}.${sig}`;
}

async function verified(app: Started["app"], subject: string) {
  const minted = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const body = overlapCast(await minted.json());
  expect(
    (
      await app.request("/v1/principals/link-identities", {
        method: "POST",
        headers: {
          authorization: `Bearer ${body.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "oidc",
          issuer: "https://mock.example",
          subject,
          assurance: "verified",
        }),
      })
    ).status,
  ).toBe(201);
  return body;
}

describe("Identity /token client_credentials", () => {
  let started: Started;
  let base: string;
  let jwtPrivate: KeyObject;
  let jwtPublic: JsonObject;

  beforeAll(async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    jwtPrivate = pair.privateKey;
    jwtPublic = publicJwk(pair.publicKey);
    const { startServer: start } = await import("../server.js");
    started = await onFreePort((port) =>
      start({
        config: {
          host: "127.0.0.1",
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          issuer: `http://127.0.0.1:${port}`,
        },
      }),
    );
    base = `http://127.0.0.1:${started.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      started.server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("mints an access token on POST /token and refuses public clients", async () => {
    const owner = await verified(started.app, "cc-token-owner");
    const created = await started.app.request("/v1/oauth/clients", {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Workload",
        redirectUris: ["https://workload.example/cb"],
        sectorIdentifier: "https://workload.example",
        grantTypes: ["client_credentials"],
        responseTypes: [],
        tokenEndpointAuthMethod: "private_key_jwt",
        jwks: { keys: [jwtPublic] },
      }),
    });
    expect(created.status).toBe(201);
    const client = overlapCast(await created.json());

    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwt(
      jwtPrivate,
      { alg: "RS256", kid: "cc-identity-1", typ: "JWT" },
      {
        iss: client.id,
        sub: client.id,
        aud: base,
        exp: now + 60,
        iat: now,
        jti: "cc-identity-jti-1",
      },
    );
    const minted = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: String(client.id),
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }),
    });
    expect(minted.status).toBe(200);
    const json = overlapCast(await minted.json());
    expect(json.access_token).toEqual(expect.any(String));
    expect(json.id_token).toBeUndefined();
    expect(json.refresh_token).toBeUndefined();
    expect(json.expires_in).toBeLessThanOrEqual(3600);

    const publicDenied = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "spa-public",
      }),
    });
    expect(publicDenied.status).toBeGreaterThanOrEqual(400);
    expect(overlapCast(await publicDenied.json()).access_token).toBeUndefined();
  }, 30_000);
});
