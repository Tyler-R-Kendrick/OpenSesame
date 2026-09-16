/**
 * The mounted OpenID4VCI issuer: F10 protected redemption (T-24) and durable,
 * non-process-local grants (T-25), driven through the real routes.
 *
 * Nothing is stubbed. The issuer key and the holder key are generated in this
 * process, the key proof is a real signature, and the durable case runs
 * against an in-process Postgres (PGlite) with the real migrations — the same
 * `DurableMap` a deployment uses. What the routes refuse, they refuse for the
 * reason the package refuses it.
 */

import { PGlite } from "@electric-sql/pglite";
import type { Database } from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { Openid4vciError, createCredentialOffer } from "@opensesame/openid4vci";
import {
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Hono } from "hono";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { Variables } from "../middleware/context.js";
import { DurableMap } from "../repos/durable-map.js";
import {
  DurableAccessTokenStore,
  DurableNonceStore,
  DurableOfferStore,
  DurablePreAuthorizedCodeStore,
  type StoredPreAuthorizedGrant,
} from "../repos/openid4vci-stores.js";
import {
  type Openid4vciIssuerRuntime,
  createOpenid4vciRoutes,
} from "../routes/openid4vci.js";

const ISSUER = "https://issuer.example.test";
const VCT = "https://credentials.example.test/opensesame-holder-binding/v1";
const CONFIG_ID = "opensesame-holder-binding";
const PEPPER = "openid4vci-route-test-pepper";
const ALICE = "prn_01J8XKQ4V7RZ9Y2M3N4P5Q6R7S";
const BOB = "prn_01J8XKQ4V7RZ9Y2M3N4P5Q6R7T";
const PRE_AUTH_GRANT = "urn:ietf:params:oauth:grant-type:pre-authorized_code";

let issuerPrivateKey: CryptoKey;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  issuerPrivateKey = privateKey;
});

/** A runtime whose four stores are plain `Map`s — the dev/test backing. */
function memoryRuntime(): Openid4vciIssuerRuntime {
  return {
    issuer: ISSUER,
    vct: VCT,
    credentialConfigurationId: CONFIG_ID,
    signing: { key: issuerPrivateKey, algorithm: "ES256" },
    subjectPepper: PEPPER,
    credentialLifetimeSeconds: 86_400,
    offerTtlSeconds: 300,
    nonceTtlSeconds: 120,
    accessTokenTtlSeconds: 120,
    grants: new DurablePreAuthorizedCodeStore(new Map()),
    nonces: new DurableNonceStore(new Map(), 120),
    offers: new DurableOfferStore(new Map()),
    accessTokens: new DurableAccessTokenStore(new Map()),
    clock: () => new Date(),
  };
}

/** Mount the issuer under a test middleware that fakes an authenticated call. */
function mount(
  runtime: Openid4vciIssuerRuntime,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => {
    const principal = c.req.header("x-test-principal");
    if (principal !== undefined) c.set("principalId", principal);
    await next();
  });
  app.route("/", createOpenid4vciRoutes(runtime));
  return app;
}

/** Build a real `openid4vci-proof+jwt` around a nonce, from a holder key. */
async function makeProof(
  privateKey: CryptoKey,
  jwk: JWK,
  nonce: string,
): Promise<string> {
  return new SignJWT({ nonce })
    .setProtectedHeader({ alg: "ES256", typ: "openid4vci-proof+jwt", jwk })
    .setIssuedAt()
    .setAudience(ISSUER)
    .sign(privateKey);
}

function offerPath(offerUri: string): string {
  return new URL(offerUri).pathname;
}

async function readJson(response: Response): Promise<JsonObject> {
  const parsed = overlapCast(await response.json());
  if (!isJsonObject(parsed)) throw new Error("response was not a JSON object");
  return parsed;
}

function requireString(object: JsonObject, key: string): string {
  const value = object[key];
  if (!isString(value)) throw new Error(`${key} is not a string`);
  return value;
}

/** The pre-authorized code inside an offer object, read through guards. */
function preAuthorizedCode(offer: JsonObject): string {
  const grants = offer.grants;
  if (!isJsonObject(grants)) throw new Error("offer has no grants");
  const params = grants[PRE_AUTH_GRANT];
  if (!isJsonObject(params))
    throw new Error("offer has no pre-authorized grant");
  return requireString(params, "pre-authorized_code");
}

/** Whether an offer advertises a Transaction Code. */
function advertisesTxCode(offer: JsonObject): boolean {
  const grants = offer.grants;
  if (!isJsonObject(grants)) return false;
  const params = grants[PRE_AUTH_GRANT];
  return isJsonObject(params) && params.tx_code !== undefined;
}

/** Mint an offer for a principal and hand back the served offer object. */
async function mintAndFetchOffer(
  app: Hono<{ Variables: Variables }>,
  principal: string,
  body: string,
): Promise<JsonObject> {
  const minted = await readJson(
    await app.request("/oid4vci/offers", {
      method: "POST",
      headers: {
        "x-test-principal": principal,
        "content-type": "application/json",
      },
      body,
    }),
  );
  const path = offerPath(requireString(minted, "offerUri"));
  return readJson(
    await app.request(path, { headers: { "x-test-principal": principal } }),
  );
}

describe("T-24: F10 — a by-reference offer is protected or it does not mint", () => {
  it("serves a session-bound offer resource only to the bound principal", async () => {
    const app = mount(memoryRuntime());
    const minted = await readJson(
      await app.request("/oid4vci/offers", {
        method: "POST",
        headers: {
          "x-test-principal": ALICE,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    const path = offerPath(requireString(minted, "offerUri"));

    // A bystander who photographed the link has no session: 404, no oracle.
    expect((await app.request(path)).status).toBe(404);
    // The wrong principal is refused identically.
    expect(
      (await app.request(path, { headers: { "x-test-principal": BOB } }))
        .status,
    ).toBe(404);
    // The principal it was minted for gets the offer object.
    const resource = await app.request(path, {
      headers: { "x-test-principal": ALICE },
    });
    expect(resource.status).toBe(200);
    expect((await readJson(resource)).credential_issuer).toBe(ISSUER);
  });

  it("refuses to redeem a session-bound code for anyone but the bound principal", async () => {
    const app = mount(memoryRuntime());
    const offer = await mintAndFetchOffer(app, ALICE, "{}");
    const code = preAuthorizedCode(offer);

    const body = JSON.stringify({
      grant_type: PRE_AUTH_GRANT,
      "pre-authorized_code": code,
    });
    // No session and the wrong session are both invalid_grant — the code alone
    // authorizes nothing for a protected offer (F10).
    const anon = await app.request("/oid4vci/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(anon.status).toBe(400);
    expect((await readJson(anon)).error).toBe("invalid_grant");

    const wrong = await app.request("/oid4vci/token", {
      method: "POST",
      headers: { "x-test-principal": BOB, "content-type": "application/json" },
      body,
    });
    expect(wrong.status).toBe(400);
    expect((await readJson(wrong)).error).toBe("invalid_grant");
  });

  it("mints an offer with a tx_code and no session binding", async () => {
    const app = mount(memoryRuntime());
    // The tx_code offer resource is not session-bound: fetch it with no session.
    const minted = await readJson(
      await app.request("/oid4vci/offers", {
        method: "POST",
        headers: {
          "x-test-principal": ALICE,
          "content-type": "application/json",
        },
        body: JSON.stringify({ transactionCode: "4821" }),
      }),
    );
    const offer = await readJson(
      await app.request(offerPath(requireString(minted, "offerUri"))),
    );
    expect(advertisesTxCode(offer)).toBe(true);
    const code = preAuthorizedCode(offer);

    // A wrong tx_code is refused (and burns the code).
    const wrong = await app.request("/oid4vci/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: PRE_AUTH_GRANT,
        "pre-authorized_code": code,
        tx_code: "0000",
      }),
    });
    expect(wrong.status).toBe(400);
  });

  it("issues a credential end to end on the protected road", async () => {
    const app = mount(memoryRuntime());
    const offer = await mintAndFetchOffer(app, ALICE, "{}");
    const code = preAuthorizedCode(offer);

    const token = await readJson(
      await app.request("/oid4vci/token", {
        method: "POST",
        headers: {
          "x-test-principal": ALICE,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: PRE_AUTH_GRANT,
          "pre-authorized_code": code,
        }),
      }),
    );
    expect(token.token_type).toBe("Bearer");
    const accessToken = requireString(token, "access_token");

    const nonce = await readJson(
      await app.request("/oid4vci/nonce", { method: "POST" }),
    );
    const cNonce = requireString(nonce, "c_nonce");

    const holder = await generateKeyPair("ES256", { extractable: true });
    const holderJwk = await exportJWK(holder.publicKey);
    const proof = await makeProof(holder.privateKey, holderJwk, cNonce);

    const response = await app.request("/oid4vci/credential", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ proof: { proof_type: "jwt", jwt: proof } }),
    });
    expect(response.status).toBe(200);
    const credential = await readJson(response);
    expect(credential.format).toBe("application/dc+sd-jwt");
    const sdJwt = requireString(credential, "credential");
    // The pairwise reference hides the principal; the raw id never appears.
    expect(sdJwt).not.toContain(ALICE);
    expect(sdJwt.endsWith("~")).toBe(true);

    // The access token was single-use: a replay mints nothing.
    const replay = await app.request("/oid4vci/credential", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ proof: { proof_type: "jwt", jwt: proof } }),
    });
    expect(replay.status).toBe(401);
  });
});

async function migratedDb() {
  const client = new PGlite();
  const drizzled = drizzle(client, { schema });
  await migrate(drizzled, {
    migrationsFolder: new URL(
      "../../../../packages/database/drizzle",
      import.meta.url,
    ).pathname,
  });
  const db: Database = overlapCast(drizzled);
  return { client, db };
}

function grantReplica(db: Database): DurablePreAuthorizedCodeStore {
  return new DurablePreAuthorizedCodeStore(
    new DurableMap<StoredPreAuthorizedGrant>(
      db,
      "OpenSesame:Oid4vciGrants",
      true,
    ),
  );
}

describe("T-25: grants are durable and not process-local", () => {
  it("registers on one replica, redeems on another, exactly once", async () => {
    const { client, db } = await migratedDb();
    try {
      const replicaA = grantReplica(db);
      const replicaB = grantReplica(db);

      const created = createCredentialOffer({
        credentialIssuer: ISSUER,
        credentialConfigurationIds: [CONFIG_ID],
        offerUri: `${ISSUER}/oid4vci/offers/durable`,
        protectedRedemption: true,
      });
      // Registered on A...
      await replicaA.register(created.grant, ALICE);

      // ...redeemed on B, with the F10 binding intact across the process line.
      const redeemed = await replicaB.redeem(
        created.grant.code,
        undefined,
        new Date(),
      );
      expect(redeemed.boundPrincipalId).toBe(ALICE);
      expect(redeemed.redeemed.requiresProtectedRedemption).toBe(true);

      // Spent: neither replica can redeem it a second time.
      await expect(
        replicaA.redeem(created.grant.code, undefined, new Date()),
      ).rejects.toBeInstanceOf(Openid4vciError);
    } finally {
      await client.close();
    }
  });

  it("lets only one of two concurrent replicas spend a code", async () => {
    const { client, db } = await migratedDb();
    try {
      const replicaA = grantReplica(db);
      const replicaB = grantReplica(db);
      const created = createCredentialOffer({
        credentialIssuer: ISSUER,
        credentialConfigurationIds: [CONFIG_ID],
        offerUri: `${ISSUER}/oid4vci/offers/race`,
        protectedRedemption: true,
      });
      await replicaA.register(created.grant, ALICE);

      const now = new Date();
      const results = await Promise.allSettled([
        replicaA.redeem(created.grant.code, undefined, now),
        replicaB.redeem(created.grant.code, undefined, now),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
