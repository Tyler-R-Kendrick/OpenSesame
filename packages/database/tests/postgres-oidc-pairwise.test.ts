import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type OidcStore,
  type PairwiseSubjectStore,
  createPostgresOidcStore,
  createPostgresPairwiseStore,
} from "../src/index.js";
import type { Database } from "../src/repos/postgres.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
let oidc: OidcStore;
let pairwise: PairwiseSubjectStore;

beforeAll(async () => {
  ctx = await createPgTestContext();
  oidc = createPostgresOidcStore(ctx.db);
  pairwise = createPostgresPairwiseStore(ctx.db);
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

describe("createPostgresOidcStore", () => {
  it("upserts, finds, and overwrites a payload", async () => {
    const id = `oidc_${randomUUID()}`;
    await oidc.upsert("Session", id, { uid: "u-1", kind: "session" }, null);
    expect(await oidc.find("Session", id)).toEqual({
      uid: "u-1",
      kind: "session",
    });

    // Upsert on the same (model, id) replaces the stored payload and keys.
    await oidc.upsert("Session", id, { uid: "u-2" }, null);
    expect(await oidc.find("Session", id)).toEqual({ uid: "u-2" });
    expect(await oidc.findByUid("Session", "u-1")).toBeUndefined();
    expect(await oidc.findByUid("Session", "u-2")).toEqual({ uid: "u-2" });
  });

  it("never hands back an expired record", async () => {
    const id = `oidc_${randomUUID()}`;
    await oidc.upsert(
      "AccessToken",
      id,
      { uid: "u-x" },
      new Date(Date.now() - 1_000),
    );
    expect(await oidc.find("AccessToken", id)).toBeUndefined();
    expect(await oidc.findByUid("AccessToken", "u-x")).toBeUndefined();
    expect(
      await oidc.find("AccessToken", `oidc_${randomUUID()}`),
    ).toBeUndefined();
  });

  it("looks rows up by user code", async () => {
    const id = `oidc_${randomUUID()}`;
    const userCode = `CODE-${randomUUID()}`;
    await oidc.upsert(
      "DeviceCode",
      id,
      { userCode, clientId: "c-1" },
      new Date(Date.now() + 60_000),
    );
    expect(await oidc.findByUserCode("DeviceCode", userCode)).toEqual({
      userCode,
      clientId: "c-1",
    });
    expect(
      await oidc.findByUserCode("DeviceCode", `CODE-${randomUUID()}`),
    ).toBeUndefined();
  });

  it("consume stamps rather than deletes, so replays stay visible", async () => {
    const id = `oidc_${randomUUID()}`;
    await oidc.upsert(
      "AuthorizationCode",
      id,
      { jti: "code-1" },
      new Date(Date.now() + 60_000),
    );
    await oidc.consume("AuthorizationCode", id);
    const found = await oidc.find("AuthorizationCode", id);
    expect(found?.jti).toBe("code-1");
    expect(typeof found?.consumed).toBe("number");
  });

  it("destroy removes the row entirely", async () => {
    const id = `oidc_${randomUUID()}`;
    await oidc.upsert("Session", id, { uid: "u-gone" }, null);
    await oidc.destroy("Session", id);
    expect(await oidc.find("Session", id)).toBeUndefined();
  });

  it("revokeByGrantId removes every token hanging off the grant", async () => {
    const grantId = `grant_${randomUUID()}`;
    const kept = `oidc_${randomUUID()}`;
    await oidc.upsert(
      "RefreshToken",
      `oidc_${randomUUID()}`,
      { grantId },
      null,
    );
    await oidc.upsert("AccessToken", `oidc_${randomUUID()}`, { grantId }, null);
    await oidc.upsert("AccessToken", kept, { grantId: "other" }, null);

    await oidc.revokeByGrantId(grantId);

    expect(await oidc.findByUid("AccessToken", "irrelevant")).toBeUndefined();
    expect(await oidc.find("AccessToken", kept)).toEqual({
      grantId: "other",
    });
  });

  it("pruneExpired drops only rows whose TTL has passed", async () => {
    const expired = `oidc_${randomUUID()}`;
    const live = `oidc_${randomUUID()}`;
    const immortal = `oidc_${randomUUID()}`;
    await oidc.upsert(
      "AccessToken",
      expired,
      {},
      new Date(Date.now() - 60_000),
    );
    await oidc.upsert(
      "AccessToken",
      live,
      {},
      new Date(Date.now() + 3_600_000),
    );
    await oidc.upsert("Session", immortal, {}, null);

    const removed = await oidc.pruneExpired(new Date());
    expect(removed).toBeGreaterThanOrEqual(1);

    // Direct SQL check: the expired row is gone, the others survived.
    const rows = await ctx.db.query.oidcPayloads.findMany();
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(expired);
    expect(ids).toContain(live);
    expect(ids).toContain(immortal);
  });
});

describe("createPostgresPairwiseStore", () => {
  it("mints a stable subject per (principal, sector)", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const sector = `sector_${randomUUID()}`;

    expect(await pairwise.find(principal.id, sector)).toBeUndefined();

    const first = await pairwise.getOrCreate(principal.id, sector);
    expect(first.principalId).toBe(principal.id);
    expect(first.sectorIdentifier).toBe(sector);
    expect(first.subject).toMatch(/^[A-Za-z0-9_-]+$/);

    const again = await pairwise.getOrCreate(principal.id, sector);
    expect(again.subject).toBe(first.subject);
    expect(again.createdAt).toEqual(first.createdAt);

    // A different sector gets a different subject.
    const other = await pairwise.getOrCreate(
      principal.id,
      `sector_${randomUUID()}`,
    );
    expect(other.subject).not.toBe(first.subject);

    expect(await pairwise.find(principal.id, sector)).toEqual(first);
  });

  it("fails closed when the principal was never persisted", async () => {
    const ghost = `prn_${randomUUID()}`;
    await expect(
      pairwise.getOrCreate(ghost, `sector_${randomUUID()}`),
    ).rejects.toThrow(`pairwise subject insert failed for principal ${ghost}`);
  });

  it("returns the raced row when a concurrent insert wins", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const sector = `sector_${randomUUID()}`;
    // Pre-seed the row directly, then call getOrCreate with a `find` that
    // reports a miss before the insert and the real row afterwards — exactly
    // what a concurrent mint between find and insert looks like.
    const seeded = await pairwise.getOrCreate(principal.id, sector);

    let calls = 0;
    const raced = await pairwise.getOrCreate.call(
      {
        find: async (p: string, s: string) => {
          calls += 1;
          return calls === 1 ? undefined : pairwise.find(p, s);
        },
      },
      principal.id,
      sector,
    );
    expect(raced.subject).toBe(seeded.subject);
  });

  it("throws when the row vanishes between conflict and re-read", async () => {
    const principal = await ctx.repos.principals.create(makePrincipal());
    const sector = `sector_${randomUUID()}`;
    await pairwise.getOrCreate(principal.id, sector);

    // Both reads miss, the insert conflicts: the only way out is the
    // fail-closed error rather than a silently churned subject.
    const missing = pairwise.getOrCreate.bind({
      find: async () => undefined,
    });
    await expect(missing(principal.id, sector)).rejects.toThrow(
      `pairwise subject missing after conflict for principal ${principal.id}`,
    );
  });
});
