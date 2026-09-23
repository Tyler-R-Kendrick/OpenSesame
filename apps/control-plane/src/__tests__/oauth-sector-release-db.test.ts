import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import * as schema from "@opensesame/database/schema";
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";

/**
 * A squatted sector, and the operator's way out: release blocks the squatter's
 * clients and bumps the key's generation, so the real owner registers under it
 * and starts from fresh pairwise subjects — never the squatter's.
 */

type Plane = ReturnType<typeof createControlPlane>;

const MIGRATIONS = new URL(
  "../../../../packages/database/drizzle",
  import.meta.url,
).pathname;

let client: PGlite;
let plane: Plane;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  plane = createControlPlane({ database: overlapCast(db) });
  await plane.ctx.systemPrincipalReady;
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function verified(): Promise<{
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
      subject: `release-${randomUUID()}`,
      assurance: "verified",
    }),
  });
  expect(linked.status).toBe(201);
  return body;
}

function post(path: string, token: string | undefined, body: JsonObject) {
  return plane.app.request(path, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : undefined),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function register(token: string, h: string): Promise<Response> {
  return post("/v1/oauth/clients", token, {
    displayName: "RP",
    redirectUris: [`https://${h}/callback`],
    sectorIdentifier: `https://${h}`,
  });
}

function release(token: string | undefined, h: string) {
  return post("/v1/oauth/admin/sectors/release", token, {
    sectorIdentifier: `https://${h}`,
    reason: "squatted; ownership verified out of band",
  });
}

function subFor(person: string, clientId: string) {
  const pairwise: (
    ctx: BoundaryValue,
    accountId: string,
    client: JsonObject,
  ) => Promise<string> = overlapCast(
    plane.ctx.oauth.configuration.pairwiseIdentifier,
  );
  return pairwise({}, person, { clientId });
}

const operator = () => plane.ctx.config.operatorToken ?? "";
const host = () => `${randomUUID().slice(0, 8)}.example`;

describe("operator release of a squatted sector", () => {
  it("hands the sector to its owner with fresh subjects", async () => {
    const [squatter, owner, person] = [
      await verified(),
      await verified(),
      await verified(),
    ];
    const h = host();
    const squat = await register(squatter.accessToken, h);
    expect(squat.status).toBe(201);
    const squatId: string = overlapCast(await squat.json()).id;
    const squatterSub = await subFor(person.principalId, squatId);

    // Revoking the squatter's client does not free the sector.
    const revoked = await post(
      `/v1/oauth/clients/${squatId}/revoke`,
      squatter.accessToken,
      {},
    );
    expect(revoked.status).toBe(200);
    expect((await register(owner.accessToken, h)).status).toBe(409);

    const released = await release(operator(), h);
    expect(released.status).toBe(200);
    expect(overlapCast(await released.json())).toMatchObject({
      sectorKey: h,
      generation: 1,
      previousOwnerKey: squatter.principalId,
      blockedClientIds: [squatId],
    });

    const admitted = await register(owner.accessToken, h);
    expect(admitted.status).toBe(201);
    const ownerId: string = overlapCast(await admitted.json()).id;
    const ownerSub = await subFor(person.principalId, ownerId);
    expect(ownerSub).not.toBe(squatterSub);
    await expect(subFor(person.principalId, squatId)).rejects.toMatchObject({
      error: "invalid_client",
    });
    // Each holder's subjects live under their own generation of the key.
    const stored = await client.query<{ sector: string; subject: string }>(
      "select sector_identifier as sector, subject from pairwise_subjects where principal_id = $1",
      [person.principalId],
    );
    expect(
      Object.fromEntries(stored.rows.map((r) => [r.sector, r.subject])),
    ).toMatchObject({ [h]: squatterSub, [`${h} #1`]: ownerSub });

    const events = await plane.ctx.repos.auditEvents.list({ limit: 500 });
    const audited = events.find(
      (e) => e.eventType === "oauth_client.sector_released" && e.targetId === h,
    );
    expect(audited?.metadata).toMatchObject({
      reason: "squatted; ownership verified out of band",
      sectorIdentifier: h,
      subjectId: squatter.principalId,
      count: 1,
      contentVersion: 1,
    });
  });

  it("refuses everyone but the operator", async () => {
    const squatter = await verified();
    const h = host();
    expect((await register(squatter.accessToken, h)).status).toBe(201);
    for (const token of [undefined, squatter.accessToken, "not-the-token"]) {
      expect((await release(token, h)).status).toBe(401);
    }
    const held = await plane.ctx.stores.oauthClients.findBySectorKey(h);
    expect(held.map((c) => c.sectorKeyBlocked)).toEqual([undefined]);
  });

  it("answers 404 for a sector nobody holds, and refuses a missing reason", async () => {
    expect((await release(operator(), host())).status).toBe(404);
    const unexplained = await post(
      "/v1/oauth/admin/sectors/release",
      operator(),
      { sectorIdentifier: `https://${host()}` },
    );
    expect(unexplained.status).toBe(400);
  });
});
