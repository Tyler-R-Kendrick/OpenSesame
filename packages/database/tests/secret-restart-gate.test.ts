import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { EventSealError, createEventSealer } from "../src/event-seal.js";
import { sealOidcRow } from "../src/oidc-seal.js";
import { sealLegacySecrets } from "../src/repos/sealed-secrets-sweep.js";
import { sealLegacySessions } from "../src/repos/sealed-sessions-sweep.js";
import * as schema from "../src/schema/index.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
const sealer = createEventSealer("restart gate fixture root");
beforeAll(async () => {
  ctx = await createPgTestContext();
});
afterAll(async () => {
  await ctx.client.close();
});
it("refuses session marker removal on restart without resetting its bearer index", async () => {
  await ctx.db.insert(schema.betterAuthUsers).values({
    id: "restart-owner",
    name: "fixture",
    email: "restart@fixture.test",
  });
  await ctx.db.insert(schema.betterAuthSessions).values({
    id: "restart-session",
    userId: "restart-owner",
    token: "restart-bearer",
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(await sealLegacySessions(ctx.db, sealer, true)).toBe(1);
  const [original] = await ctx.db.select().from(schema.betterAuthSessions);
  if (!original) throw new Error("missing fixture");
  await ctx.db
    .update(schema.betterAuthSessions)
    .set({ sealedToken: null })
    .where(eq(schema.betterAuthSessions.id, original.id));
  const [before] = await ctx.db.select().from(schema.betterAuthSessions);
  await expect(sealLegacySecrets(ctx.db, sealer, false)).rejects.toBeInstanceOf(
    EventSealError,
  );
  expect(await ctx.db.select().from(schema.betterAuthSessions)).toEqual([
    before,
  ]);
  await ctx.db
    .update(schema.betterAuthSessions)
    .set({ sealedToken: original.sealedToken })
    .where(eq(schema.betterAuthSessions.id, original.id));
  expect(await sealLegacySecrets(ctx.db, sealer, false)).toBe(0);
});
it.each(["marker-only", "payload-and-marker"])(
  "refuses OIDC %s downgrade on restart without rewriting storage",
  async (mode) => {
    const original = sealOidcRow(
      sealer,
      "RefreshToken",
      `restart-token-${mode}`,
      {
        accountId: "customer-a",
        clientId: "fixture-client",
        jti: "private-bearer",
      },
    );
    await ctx.db.insert(schema.oidcPayloads).values(original);
    await ctx.db
      .update(schema.oidcPayloads)
      .set({
        sealScope: null,
        payload:
          mode === "marker-only"
            ? original.payload
            : { accountId: "foreign-customer", jti: "old-private-bearer" },
      })
      .where(eq(schema.oidcPayloads.id, original.id));
    const before = await ctx.db
      .select()
      .from(schema.oidcPayloads)
      .where(eq(schema.oidcPayloads.id, original.id));
    await expect(
      sealLegacySecrets(ctx.db, sealer, false),
    ).rejects.toBeInstanceOf(EventSealError);
    expect(
      await ctx.db
        .select()
        .from(schema.oidcPayloads)
        .where(eq(schema.oidcPayloads.id, original.id)),
    ).toEqual(before);
    await ctx.db
      .update(schema.oidcPayloads)
      .set(original)
      .where(eq(schema.oidcPayloads.id, original.id));
    expect(await sealLegacySecrets(ctx.db, sealer, false)).toBe(0);
  },
);
