import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ClientClaimChallengeStore,
  type ClientRecordStore,
  type OAuthClientRecord,
  createPostgresClientClaimChallengeStore,
  createPostgresClientRecordStore,
} from "../src/index.js";
import { oauthClients } from "../src/schema/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
let clients: ClientRecordStore;
let challenges: ClientClaimChallengeStore;

beforeAll(async () => {
  ctx = await createPgTestContext();
  clients = createPostgresClientRecordStore(ctx.db);
  challenges = createPostgresClientClaimChallengeStore(ctx.db);
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

function makeClient(
  overrides: Partial<OAuthClientRecord> = {},
): OAuthClientRecord & { origin: string } {
  const origin = `https://app-${randomUUID()}.example.com`;
  return {
    id: `origin:${origin}`,
    admissionMode: "origin_profile",
    displayName: "Example app",
    redirectUris: [`${origin}/opensesame/callback`],
    sectorIdentifier: origin,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    allowedResources: [],
    state: "active",
    origin,
    ...overrides,
  } as OAuthClientRecord & { origin: string };
}

describe("createPostgresClientRecordStore", () => {
  it("round-trips a record and defaults ownership fields", async () => {
    const client = makeClient();
    const inserted = await clients.insertAtomic(client);

    expect(inserted.id).toBe(client.id);
    expect(inserted.origin).toBe(client.origin);
    expect(inserted.ownershipStatus).toBe("unclaimed");
    expect(inserted.firstSeenAt).toBeInstanceOf(Date);
    expect(inserted.lastUsedAt).toBeInstanceOf(Date);
    expect(inserted.claimedAt).toBeUndefined();

    expect(await clients.findById(client.id)).toEqual(inserted);
  });

  it("finds a client by its canonical origin", async () => {
    const client = makeClient();
    await clients.insertAtomic(client);

    expect(await clients.findByOrigin(client.origin)).toEqual(
      await clients.findById(client.id),
    );
    expect(
      await clients.findByOrigin(`https://nope-${randomUUID()}.example.com`),
    ).toBeUndefined();
  });

  it("returns the winner when an insert races on the same id", async () => {
    const client = makeClient();
    const first = await clients.insertAtomic(client);

    const loser = makeClient({
      id: client.id,
      origin: client.origin,
      displayName: "Racing loser",
    });
    const resolved = await clients.insertAtomic(loser);

    expect(resolved.displayName).toBe(first.displayName);
    expect(resolved.firstSeenAt).toEqual(first.firstSeenAt);
  });

  it("returns the winner when an insert races on the same origin", async () => {
    const client = makeClient();
    const first = await clients.insertAtomic(client);

    // A derived id is deterministic per origin, but a buggy or hostile
    // caller could present a different id for an origin already taken: the
    // partial unique index decides, and the loser gets the persisted row.
    const resolved = await clients.insertAtomic(
      makeClient({
        id: `origin:shadow-${randomUUID()}`,
        origin: client.origin,
      }),
    );

    expect(resolved.id).toBe(first.id);
    expect(await clients.findByOrigin(client.origin)).toEqual(first);
  });

  it("enforces origin uniqueness at the database level", async () => {
    const client = makeClient();
    await clients.insertAtomic(client);

    await expect(
      ctx.db.insert(oauthClients).values({
        id: `origin:dup-${randomUUID()}`,
        admissionMode: "origin_profile",
        displayName: "Duplicate origin",
        sectorIdentifier: client.origin,
        tokenEndpointAuthMethod: "none",
        state: "active",
        origin: client.origin,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("touchLastUsed stamps only the usage timestamps", async () => {
    const client = makeClient();
    const inserted = await clients.insertAtomic(client);

    const usedAt = new Date(Date.now() + 60_000);
    await clients.touchLastUsed?.(client.id, usedAt);

    const touched = await clients.findById(client.id);
    expect(touched?.lastUsedAt).toEqual(usedAt);
    expect(touched?.firstSeenAt).toEqual(inserted.firstSeenAt);
    expect(touched?.ownershipStatus).toBe("unclaimed");
  });
});

describe("createPostgresClientClaimChallengeStore", () => {
  async function makeChallenge(overrides: { expiresAt?: Date } = {}) {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const client = await clients.insertAtomic(makeClient());
    return challenges.insert({
      id: `chl_${randomUUID()}`,
      applicationId: client.id,
      ownerPrincipalId: principal.id,
      challenge: `challenge-${randomUUID()}`,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 600_000),
    });
  }

  it("issues and finds a challenge", async () => {
    const issued = await makeChallenge();
    expect(issued.consumedAt).toBeUndefined();

    const found = await challenges.findByChallenge(issued.challenge);
    expect(found).toEqual(issued);
    expect(
      await challenges.findByChallenge(`challenge-${randomUUID()}`),
    ).toBeUndefined();
  });

  it("consume stamps once; a replay gets nothing", async () => {
    const issued = await makeChallenge();
    const at = new Date();

    const consumed = await challenges.consume(issued.challenge, at);
    expect(consumed?.consumedAt).toEqual(at);

    // Single-use: the second consume — even immediately after — finds the
    // row already stamped and refuses.
    expect(
      await challenges.consume(issued.challenge, new Date()),
    ).toBeUndefined();
    expect(
      (await challenges.findByChallenge(issued.challenge))?.consumedAt,
    ).toEqual(at);
  });

  it("refuses to consume an expired challenge", async () => {
    const issued = await makeChallenge({
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(
      await challenges.consume(issued.challenge, new Date()),
    ).toBeUndefined();
    expect(
      (await challenges.findByChallenge(issued.challenge))?.consumedAt,
    ).toBeUndefined();
  });
});
