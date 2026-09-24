import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { oauthClients, sectorKeyOf } from "@opensesame/database";
import * as schema from "@opensesame/database/schema";
import { pairwiseSectorKey } from "@opensesame/oauth-provider";
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

type Plane = ReturnType<typeof createControlPlane>;

const MIGRATIONS = new URL(
  "../../../../packages/database/drizzle",
  import.meta.url,
).pathname;

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let first: Plane;
let second: Plane;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  // Two replicas of the Identity API over one database.
  const options = { database: overlapCast(db) };
  first = createControlPlane(options);
  second = createControlPlane(options);
  await Promise.all([
    first.ctx.systemPrincipalReady,
    second.ctx.systemPrincipalReady,
  ]);
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function verified(plane: Plane): Promise<{
  accessToken: string;
  principalId: string;
}> {
  const minted = await plane.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  const body = overlapCast(await minted.json());
  const linked = await plane.app.request("/v1/principals/link-identities", {
    method: "POST",
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "oidc",
      issuer: "https://mock.example",
      subject: `sector-${randomUUID()}`,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return body;
}

function register(plane: Plane, token: string, sectorIdentifier: string) {
  return plane.app.request("/v1/oauth/clients", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      displayName: "RP",
      redirectUris: ["http://127.0.0.1:5173/callback"],
      sectorIdentifier,
    }),
  });
}

/** A registration stored as the API wrote it before canonicalization. */
function legacyRow(ownerPrincipalId: string, sectorIdentifier: string) {
  return {
    id: `cli_${randomUUID()}`,
    ownerPrincipalId,
    admissionMode: "pre_registered",
    displayName: "Legacy RP",
    redirectUris: ["http://127.0.0.1:5173/callback"],
    sectorIdentifier,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    allowedResources: [],
    state: "active",
  } as const;
}

/** The pairwise `sub` one person (a real principal: the table has an FK) gets. */
function subFor(plane: Plane, person: string, clientId: string) {
  const pairwise: (
    ctx: BoundaryValue,
    accountId: string,
    client: JsonObject,
  ) => Promise<string> = overlapCast(
    plane.ctx.oauth.configuration.pairwiseIdentifier,
  );
  return pairwise({}, person, {
    clientId,
    sectorIdentifier: "127.0.0.1:5173",
  });
}

const host = () => `${randomUUID().slice(0, 8)}.example`;

describe("oauth client sector keys on Postgres", () => {
  it("derives the key the issuer does from every spelling", () => {
    for (const spelling of [
      "https://RP.example:443/",
      "https://rp.example:8443/a/",
      "http://rp.example:80",
      "  https://rp.example/p  ",
      "sector_abc",
      "localhost:3000",
      "not a url",
    ]) {
      expect(sectorKeyOf(spelling), spelling).toBe(pairwiseSectorKey(spelling));
    }
  });

  it("refuses the canonical spelling of a legacy row another owner holds", async () => {
    const [alice, bob] = [await verified(first), await verified(first)];
    const h = host();
    await first.ctx.stores.oauthClients.insertAtomic(
      legacyRow(alice.principalId, `https://${h.toUpperCase()}:443/`),
    );
    for (const spelling of [`https://${h}`, `https://${h}/`]) {
      const res = await register(first, bob.accessToken, spelling);
      expect(res.status, spelling).toBe(409);
      expect(overlapCast(await res.json()).error).toBe(
        "sector_identifier_taken",
      );
    }
    // The legacy holder still reuses its own key.
    expect(
      (await register(first, alice.accessToken, `https://${h}`)).status,
    ).toBe(201);
  });

  it("issues no sub to a legacy collision, and refuses rotating it onto the key", async () => {
    const [alice, bob] = [await verified(first), await verified(first)];
    const h = host();
    const held = await first.ctx.stores.oauthClients.insertAtomic(
      legacyRow(alice.principalId, `https://${h}`),
    );
    const collided = legacyRow(bob.principalId, `https://${h.toUpperCase()}/`);
    await db.insert(oauthClients).values({
      ...collided,
      sectorKey: h,
      sectorKeyBlocked: "cross_owner_collision",
    });
    const person = alice.principalId;
    await expect(subFor(first, person, held.id)).resolves.toEqual(
      expect.any(String),
    );
    await expect(subFor(first, person, collided.id)).rejects.toMatchObject({
      error: "invalid_client",
    });
    const rotated = await first.app.request(
      `/v1/oauth/clients/${collided.id}/rotate`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${bob.accessToken}` },
      },
    );
    expect(rotated.status).toBe(409);
    // A refused rotation retires nothing.
    const stored = await first.ctx.stores.oauthClients.findById(collided.id);
    expect(stored?.state).toBe("active");
  });

  it("gives distinct keys distinct subs and one owner's clients one sub", async () => {
    const [alice, bob] = [await verified(first), await verified(first)];
    const [ha, hb] = [host(), host()];
    const ids: string[] = [];
    for (const [token, sector] of [
      [alice.accessToken, `https://${ha}`],
      [alice.accessToken, `https://${ha.toUpperCase()}/`],
      [bob.accessToken, `https://${hb}`],
    ] as const) {
      const res = await register(first, token, sector);
      expect(res.status).toBe(201);
      ids.push(overlapCast(await res.json()).id);
    }
    const [a1, a2, b1] = await Promise.all(
      ids.map((id) => subFor(first, bob.principalId, id)),
    );
    expect(a1).toBe(a2);
    expect(b1).not.toBe(a1);
  });

  it("admits exactly one of two owners racing for one key on two replicas", async () => {
    const [alice, bob] = [await verified(first), await verified(second)];
    const h = host();
    const results = await Promise.all([
      register(first, alice.accessToken, `https://${h}`),
      register(second, bob.accessToken, `https://${h.toUpperCase()}:443/`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const holders = new Set(
      (await first.ctx.stores.oauthClients.findBySectorKey(h)).map(
        (c) => c.ownerPrincipalId,
      ),
    );
    expect(holders.size).toBe(1);
  });
});
