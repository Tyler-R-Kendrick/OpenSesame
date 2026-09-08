import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import { overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { importJWK, jwtVerify } from "jose";
import { expect, it } from "vitest";
import {
  type CreateControlPlaneOptions,
  createControlPlane,
} from "../create-app.js";

async function fixture(options: CreateControlPlaneOptions = {}) {
  const signingKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ format: "jwk" });
  const planeOptions = {
    ...options,
    config: { ...options.config, publicUrl: "http://localhost:8788" },
    processEnv: {
      ...process.env,
      OPENSESAME_HOST_AUTHORIZATION_AUDIENCES: "http://127.0.0.1:8787",
      OPENSESAME_JWKS_JSON: JSON.stringify({
        keys: [
          { ...signingKey, alg: "RS256", kid: "test-host-key", use: "sig" },
        ],
      }),
    },
  };
  const plane = createControlPlane(planeOptions);
  const minted = await (
    await plane.app.request("/v1/principals/provisional", { method: "POST" })
  ).json();
  const memberships =
    await plane.ctx.stores.organizationMemberships.listByPrincipal(
      minted.principalId,
    );
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) throw new Error("Fixture organization missing");
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = key.publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("Fixture public coordinates missing");
  const publicKey = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const credentialId = randomBytes(32).toString("base64url");
  await plane.ctx.passkeys.register(minted.principalId, {
    credentialId,
    publicKey,
    counter: 0,
  });
  const headers = {
    authorization: `Bearer ${minted.accessToken}`,
    "content-type": "application/json",
  };
  const challenge = {
    challenge_id: "challenge_1",
    challenge_digest: "a".repeat(64),
    host_audience: "http://127.0.0.1:8787",
    organization_id: organizationId,
    operation: "agent.browser.control",
    transition: "take",
    target_id: "run_1",
    origin: "https://vault.example",
    dpop_jkt: "b".repeat(43),
    expires_at: Math.floor(Date.now() / 1000) + 240,
  };
  async function begin() {
    const response = await plane.app.request(
      "/v1/host-authorizations/options",
      { method: "POST", headers, body: JSON.stringify(challenge) },
    );
    expect(response.status).toBe(200);
    return response.json();
  }
  function assertion(
    pending: { authorization_id: string; options: { challenge: string } },
    uv = true,
    counter = 1,
  ) {
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: pending.options.challenge,
        origin: "http://localhost:8788",
      }),
    );
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const authData = Buffer.concat([
      createHash("sha256").update("localhost").digest(),
      Buffer.from([uv ? 5 : 1]),
      count,
    ]);
    const signature = sign(
      "sha256",
      Buffer.concat([
        authData,
        createHash("sha256").update(clientData).digest(),
      ]),
      key.privateKey,
    );
    return {
      authorization_id: pending.authorization_id,
      credentialId,
      clientDataJSON: clientData.toString("base64url"),
      authenticatorData: authData.toString("base64url"),
      signature: signature.toString("base64url"),
    };
  }
  const verify = (body: ReturnType<typeof assertion>) =>
    plane.app.request("/v1/host-authorizations/verify", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return {
    ...plane,
    planeOptions,
    minted,
    headers,
    challenge,
    begin,
    assertion,
    verify,
  };
}

it("uses real UV signatures even with dev defaults, signs the frozen tuple and spends once", async () => {
  const f = await fixture();
  const first = await f.begin();
  expect((await f.verify(f.assertion(first, false))).status).toBe(403);
  const second = await f.begin();
  const body = f.assertion(second);
  const responses = await Promise.all([f.verify(body), f.verify(body)]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 403,
  ]);
  const success = responses.find((response) => response.status === 200);
  if (!success) throw new Error("No winning assertion");
  const signed = await success.json();
  const jwk = f.ctx.oauth.configuration.jwks?.keys[0];
  const { payload, protectedHeader } = await jwtVerify(
    signed.assertion,
    await importJWK(
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" },
      "RS256",
    ),
    {
      algorithms: ["RS256"],
      issuer: f.config.issuer,
      audience: f.challenge.host_audience,
    },
  );
  expect(protectedHeader.typ).toBe("host-authorization+jwt");
  expect(payload).toMatchObject({
    ...f.challenge,
    sub: f.minted.principalId,
    amr: ["webauthn"],
    assurance: "phishing_resistant",
    organization_role: "owner",
  });
});

it("refuses caller assurance, unknown audiences, wrong transaction, and removed membership", async () => {
  const f = await fixture();
  for (const extra of [
    { auth_time: 1 },
    { amr: ["webauthn"] },
    { organization_role: "owner" },
  ]) {
    expect(
      (
        await f.app.request("/v1/host-authorizations/options", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ ...f.challenge, ...extra }),
        })
      ).status,
    ).toBe(400);
  }
  for (const override of [
    { host_audience: "https://foreign.example" },
    { transition: null },
    { expires_at: 1 },
    { origin: "https://vault.example/path" },
  ]) {
    expect(
      (
        await f.app.request("/v1/host-authorizations/options", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ ...f.challenge, ...override }),
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  }
  const one = await f.begin();
  const two = await f.begin();
  expect(
    (
      await f.verify({
        ...f.assertion(one),
        authorization_id: two.authorization_id,
      })
    ).status,
  ).toBe(403);
  await f.ctx.stores.organizationMemberships.remove(
    f.challenge.organization_id,
    f.minted.principalId,
  );
  expect((await f.verify(f.assertion(one))).status).toBe(403);
});

it("verifies a real passkey on another app instance and consumes the pending grant atomically", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: new URL(
        "../../../../packages/database/drizzle",
        import.meta.url,
      ).pathname,
    });
    const first = await fixture({ database: overlapCast(db) });
    const pending = await first.begin();
    const second = createControlPlane(first.planeOptions);
    const input = first.assertion(pending);
    const results = await Promise.all([
      first.verify(input),
      second.app.request("/v1/host-authorizations/verify", {
        method: "POST",
        headers: first.headers,
        body: JSON.stringify(input),
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 403]);
    expect(
      await second.ctx.stores.hostAuthorizations.get(pending.authorization_id),
    ).toBeUndefined();
  } finally {
    await client.close();
  }
});
