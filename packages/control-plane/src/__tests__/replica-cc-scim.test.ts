import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import {
  type ReferenceIdp,
  startReferenceIdp,
} from "@opensesame/mock-upstream-idp/testkit";
import { isString, overlapCast } from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { startServer } from "../server.js";
import {
  ccBody,
  clientAssertion,
  postToken,
  rsaPair,
} from "./cc-token-helpers.js";
import { onFreePort } from "./free-port.js";
import {
  DEFAULT_IDP_SUBJECT,
  PAGES_ORIGIN,
  joinTenant,
  mintOrgIdToken,
  mintScimToken,
  patchScim,
  provisionUser,
  provisional,
  seedTenant,
  testConfig,
  usersPath,
} from "./scim-test-helpers.js";

type Started = Awaited<ReturnType<typeof startServer>>;

const MIGRATIONS = new URL(
  "../../../../packages/database/drizzle",
  import.meta.url,
).pathname;
const OPERATOR = "replica-operator-token";
const PEPPER = "replica-test-only-claim-pepper-32chars";

let idp: ReferenceIdp;
let pg: PGlite | undefined;
let first: Started | undefined;
let second: Started | undefined;

beforeAll(async () => {
  idp = await startReferenceIdp();
}, 30_000);

afterAll(async () => {
  await idp.close();
});

afterEach(async () => {
  await Promise.all(
    [first, second].map(
      (started) =>
        started &&
        new Promise<void>((resolve, reject) => {
          started.server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
  first = undefined;
  second = undefined;
  await pg?.close();
  pg = undefined;
});

type ReplicaPair = {
  issuer: string;
  tokenA: string;
  tokenB: string;
};

async function startPair(): Promise<ReplicaPair> {
  pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const { startServer: start } = await import("../server.js");
  first = await onFreePort((port) =>
    start({
      database: overlapCast(db),
      config: {
        ...testConfig(idp.issuer),
        host: "127.0.0.1",
        port,
        publicUrl: `http://127.0.0.1:${port}`,
        issuer: `http://127.0.0.1:${port}`,
        claimPepper: PEPPER,
        operatorToken: OPERATOR,
      },
    }),
  );
  const issuer = `http://127.0.0.1:${first.port}`;
  second = await onFreePort((port) =>
    start({
      database: overlapCast(db),
      config: {
        ...testConfig(idp.issuer),
        host: "127.0.0.1",
        port,
        publicUrl: issuer,
        issuer,
        claimPepper: PEPPER,
        operatorToken: OPERATOR,
      },
    }),
  );
  return {
    issuer,
    tokenA: `${issuer}/token`,
    tokenB: `http://127.0.0.1:${second.port}/token`,
  };
}

describe("J-REPLICA enrollment, SCIM, and client_credentials", () => {
  it("shares tickets, JWKS, token replay, and deprovision across two HTTP instances", async () => {
    const { issuer, tokenA, tokenB } = await startPair();
    if (!first || !second) throw new Error("replica pair did not start");

    const mint = await first.app.request("/v1/enrollment/tickets", {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPERATOR}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ttlSeconds: 120 }),
    });
    expect(mint.status).toBe(201);
    const ticketBody = overlapCast(await mint.json());
    if (!isString(ticketBody.ticket)) throw new Error("no ticket");
    const consume = await second.app.request("/v1/enrollment/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticket: ticketBody.ticket,
        organization: { slug: "replica-cc", displayName: "Replica CC" },
      }),
    });
    expect(consume.status).toBe(201);
    const replayTicket = await first.app.request("/v1/enrollment/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticket: ticketBody.ticket,
        organization: { slug: "other", displayName: "Other" },
      }),
    });
    expect(replayTicket.status).toBe(401);

    const keys = rsaPair("replica-cc-1");
    const { owner, org } = await seedTenant(first.app, "replica-cc-org", idp);
    const created = await first.app.request("/v1/oauth/clients", {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Replica workload",
        redirectUris: ["https://replica-cc.example/cb"],
        sectorIdentifier: "https://replica-cc.example",
        grantTypes: ["client_credentials"],
        responseTypes: [],
        tokenEndpointAuthMethod: "private_key_jwt",
        jwks: { keys: [keys.jwk] },
      }),
    });
    expect(created.status).toBe(201);
    const client = overlapCast(await created.json());
    expect(
      (await second.ctx.oauth.clientStore.findById(String(client.id)))?.jwks
        ?.keys[0]?.kid,
    ).toBe("replica-cc-1");

    const assertion = clientAssertion(
      keys.privateKey,
      "replica-cc-1",
      String(client.id),
      issuer,
      "replica-jti-1",
    );
    const minted = await postToken(
      tokenB,
      ccBody(String(client.id), assertion),
    );
    expect(minted.status).toBe(200);
    expect(minted.json.access_token).toEqual(expect.any(String));
    const replayed = await postToken(
      tokenA,
      ccBody(String(client.id), assertion),
    );
    expect(replayed.status).toBeGreaterThanOrEqual(400);
    expect(replayed.json.access_token).toBeUndefined();

    const { token } = await mintScimToken(first.app, org.id, owner.accessToken);
    idp.setSubject("replica-cc-user");
    const { idToken, subject } = await mintOrgIdToken(idp, PAGES_ORIGIN);
    idp.setSubject(DEFAULT_IDP_SUBJECT);
    const user = await provisionUser(first.app, org.id, token, {
      userName: "ada@replica-cc.example",
      externalId: subject,
    });
    expect(user.status).toBe(201);
    const guest = await provisional(first.app);
    expect(
      (
        await joinTenant(
          first.app,
          "replica-cc-org",
          guest.accessToken,
          idToken,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await patchScim(
          first.app,
          usersPath(org.id, `/${user.body.id}`),
          token,
          [{ op: "replace", path: "active", value: false }],
        )
      ).status,
    ).toBe(200);
    expect(
      await second.ctx.stores.organizationMemberships.find(
        org.id,
        guest.principalId,
      ),
    ).toBeUndefined();
  }, 60_000);
});
