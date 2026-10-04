/**
 * The Postgres `authority_projection_state` store, on whichever engine
 * `createPgTestContext` picks (PGlite, or the real server named by
 * DATABASE_URL).
 *
 * The memory store has its own suite. This one exists because the Postgres
 * store's `COALESCE(dirty_since, <now>)` bound a `Date` inside raw SQL, which
 * postgres-js cannot serialize — an error no in-process engine reproduces.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AuthorityProjectionMark,
  PostgresAuthorityProjectionStateStore,
} from "../src/repos/authority-projection-state.js";
import * as schema from "../src/schema/index.js";
import { makePrincipal } from "./factories.js";
import { type PgTestContext, createPgTestContext } from "./pg-harness-full.js";

let ctx: PgTestContext;
let store: PostgresAuthorityProjectionStateStore;
let mark: (revision: number) => AuthorityProjectionMark;

beforeAll(async () => {
  ctx = await createPgTestContext();
  const principal = await ctx.repos.principals.create(makePrincipal());
  const now = new Date();
  await ctx.db.insert(schema.organizations).values({
    id: "org:one",
    slug: "one",
    displayName: "One",
    state: "active",
    createdBy: principal.id,
    createdAt: now,
    updatedAt: now,
  });
  store = new PostgresAuthorityProjectionStateStore(ctx.db);
  mark = (revision) => ({
    organizationId: "org:one",
    subjectKind: "grant",
    subjectId: "grant:root",
    committedRevision: revision,
  });
}, 60_000);

afterAll(async () => {
  await ctx.client.close();
});

describe("PostgresAuthorityProjectionStateStore", () => {
  it("keeps the first dirty-since when it is marked dirty again", async () => {
    const first = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date("2026-01-02T00:00:00.000Z");
    await store.markDirty(mark(1), first);
    await store.markDirty(mark(2), later);
    expect(await store.projectionApplied(mark(2))).toBe(false);
    expect(await store.recordApplied(mark(2), "model:1", later)).toBe(true);
    expect(await store.projectionApplied(mark(2), "model:1")).toBe(true);
  });

  it("records an error without clearing the dirty mark", async () => {
    await store.markDirty(mark(3), new Date("2026-02-01T00:00:00.000Z"));
    expect(
      await store.recordError(
        mark(3),
        "openfga unavailable",
        new Date("2026-02-02T00:00:00.000Z"),
      ),
    ).toBe(true);
    expect(await store.projectionApplied(mark(3))).toBe(false);
  });
});
