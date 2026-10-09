import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { EventSealError, createEventSealer } from "../src/event-seal.js";
import { createPostgresOidcStore } from "../src/oidc-store.js";
import { sealLegacyOidc } from "../src/repos/sealed-oidc-sweep.js";
import * as schema from "../src/schema/index.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
const sealer = createEventSealer("oidc envelope deployment test key");
beforeAll(async () => {
  ctx = await createPgTestContext();
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await ctx.client.close();
});

it("persists opaque token jti and lookup capabilities only as keyed indexes and envelopes", async () => {
  // oidc-provider's opaque format returns value=this.jti; the raw database ID is the bearer.
  const token = randomBytes(32).toString("base64url");
  const payload = {
    jti: token,
    accountId: "customer-a",
    clientId: "client",
    uid: "interaction-capability",
    userCode: "USER-CODE",
    grantId: "grant-capability",
    format: "opaque",
  };
  const store = createPostgresOidcStore(ctx.db, sealer);
  await store.upsert("RefreshToken", token, payload, null);
  const rows = await ctx.db.select().from(schema.oidcPayloads);
  const dump = JSON.stringify(rows);
  for (const secret of [token, payload.uid, payload.userCode, payload.grantId])
    expect(dump).not.toContain(secret);
  expect(await store.find("RefreshToken", token)).toEqual(payload);
  expect(await store.findByUid("RefreshToken", payload.uid)).toEqual(payload);
  expect(await store.findByUserCode("RefreshToken", payload.userCode)).toEqual(
    payload,
  );
  await store.consume("RefreshToken", token);
  expect((await store.find("RefreshToken", token))?.consumed).toBeTypeOf(
    "number",
  );
  await store.upsert(
    "AccessToken",
    "access-bearer",
    { ...payload, jti: "access-bearer" },
    null,
  );
  await store.revokeByGrantId(payload.grantId);
  expect(await store.find("RefreshToken", token)).toBeUndefined();
  expect(await store.find("AccessToken", "access-bearer")).toBeUndefined();
});

it("upgrades legacy bearer rows atomically and preserves consumed state", async () => {
  const token = "legacy-refresh-bearer";
  const consumedAt = new Date(1_700_000_000_000);
  const payload = {
    accountId: "legacy-customer",
    clientId: "client",
    jti: token,
    uid: "legacy-uid",
    userCode: "LEGACY-CODE",
    grantId: "legacy-grant",
  };
  await ctx.db.insert(schema.oidcPayloads).values({
    model: "RefreshToken",
    id: token,
    payload,
    uid: payload.uid,
    userCode: payload.userCode,
    grantId: payload.grantId,
    consumedAt,
  });
  expect(await sealLegacyOidc(ctx.db, sealer)).toBe(1);
  expect(await sealLegacyOidc(ctx.db, sealer)).toBe(0);
  const store = createPostgresOidcStore(ctx.db, sealer);
  expect(await store.find("RefreshToken", token)).toEqual({
    ...payload,
    consumed: 1_700_000_000,
  });
  expect(await store.findByUid("RefreshToken", payload.uid)).toEqual({
    ...payload,
    consumed: 1_700_000_000,
  });
  const [raw] = await ctx.db.select().from(schema.oidcPayloads);
  expect(JSON.stringify(raw)).not.toContain(token);
  if (!raw) throw new Error("missing migrated token");
  await ctx.db
    .update(schema.oidcPayloads)
    .set({ sealScope: "another-customer" })
    .where(eq(schema.oidcPayloads.id, raw.id));
  await expect(store.find("RefreshToken", token)).rejects.toThrow(
    EventSealError,
  );
  await ctx.db
    .delete(schema.oidcPayloads)
    .where(eq(schema.oidcPayloads.id, raw.id));
});

it("requires a sealing key for durable issuer storage", () => {
  expect(() => createPostgresOidcStore(ctx.db)).toThrow("sealing key");
});

it("fails closed on a legacy reindex conflict without replacing the current token", async () => {
  const store = createPostgresOidcStore(ctx.db, sealer);
  const token = "legacy-conflicting-token";
  await store.upsert(
    "RefreshToken",
    token,
    { accountId: "current-customer", jti: token },
    null,
  );
  await ctx.db.insert(schema.oidcPayloads).values({
    model: "RefreshToken",
    id: token,
    payload: { accountId: "legacy-customer", jti: token },
  });
  try {
    await expect(sealLegacyOidc(ctx.db, sealer)).rejects.toThrow();
    expect((await store.find("RefreshToken", token))?.accountId).toBe(
      "current-customer",
    );
    const [legacy] = await ctx.db
      .select()
      .from(schema.oidcPayloads)
      .where(eq(schema.oidcPayloads.id, token));
    expect(legacy?.payload.accountId).toBe("legacy-customer");
  } finally {
    await ctx.db
      .delete(schema.oidcPayloads)
      .where(eq(schema.oidcPayloads.id, token));
    await store.destroy("RefreshToken", token);
  }
});

it("preserves a concurrent legacy payload rotation during atomic reindexing", async () => {
  const token = "legacy-concurrent-token";
  await ctx.db.insert(schema.oidcPayloads).values({
    model: "RefreshToken",
    id: token,
    payload: { accountId: "customer-a" },
  });
  let rotation: Promise<void> | undefined;
  const migrating = {
    ...sealer,
    seal(
      purpose: string,
      value: import("@opensesame/os-domain").JsonObject,
      scope?: string,
    ) {
      rotation = ctx.db
        .update(schema.oidcPayloads)
        .set({ payload: { accountId: "rotated-customer" } })
        .where(eq(schema.oidcPayloads.id, token))
        .then(() => undefined);
      // Await the competing writer before executing the migration's CAS.
      const update = ctx.db.update.bind(ctx.db);
      vi.spyOn(ctx.db, "update").mockImplementationOnce(function guardedUpdate<
        T extends PgTable,
      >(table: T) {
        const builder = update(table);
        const set = builder.set.bind(builder);
        vi.spyOn(builder, "set").mockImplementationOnce((values) => {
          const query = set(values);
          const execute = query.execute.bind(query);
          vi.spyOn(query, "execute").mockImplementation(async (parameters) => {
            await rotation;
            return execute(parameters);
          });
          return query;
        });
        return builder;
      });
      return sealer.seal(purpose, value, scope);
    },
  };
  expect(await sealLegacyOidc(ctx.db, migrating)).toBe(0);
  await rotation;
  const [legacy] = await ctx.db
    .select()
    .from(schema.oidcPayloads)
    .where(eq(schema.oidcPayloads.id, token));
  expect(legacy?.payload).toEqual({ accountId: "rotated-customer" });
  expect(await sealLegacyOidc(ctx.db, sealer)).toBe(1);
  expect(
    (await createPostgresOidcStore(ctx.db, sealer).find("RefreshToken", token))
      ?.accountId,
  ).toBe("rotated-customer");
});
