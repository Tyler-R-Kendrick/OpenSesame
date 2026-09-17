/**
 * INV-CONSISTENCY — Identity `authority_projection_state` fence (memory store).
 *
 * Mirrors Host `crates/storage/tests/authority_projection.rs` refusals:
 * absent denies, partial apply does not satisfy, cannot claim ahead of ledger,
 * never goes backwards, model id must match when required, errors stay dirty.
 */

import { describe, expect, it } from "vitest";
import {
  type AuthorityProjectionMark,
  type AuthorityProjectionStateStore,
  createMemoryAuthorityProjectionStateStore,
} from "../src/repos/authority-projection-state.js";

function mark(revision: number): AuthorityProjectionMark {
  return {
    organizationId: "org:one",
    subjectKind: "grant",
    subjectId: "grant:root",
    committedRevision: revision,
  };
}

describe("AuthorityProjectionStateStore (INV-CONSISTENCY Identity fence)", () => {
  it("treats an absent projection as unknown and denies", async () => {
    const store: AuthorityProjectionStateStore =
      createMemoryAuthorityProjectionStateStore();
    expect(await store.projectionApplied(mark(1))).toBe(false);
  });

  it("satisfies a fence only after applying the required revision", async () => {
    const store = createMemoryAuthorityProjectionStateStore();
    await store.markDirty(mark(4));
    expect(await store.projectionApplied(mark(4))).toBe(false);

    expect(await store.recordApplied(mark(3), "model:1")).toBe(true);
    expect(await store.projectionApplied(mark(4))).toBe(false);

    expect(await store.recordApplied(mark(4), "model:1")).toBe(true);
    expect(await store.projectionApplied(mark(4))).toBe(true);
  });

  it("refuses to claim a revision the authority never committed", async () => {
    const store = createMemoryAuthorityProjectionStateStore();
    await store.markDirty(mark(2));
    expect(await store.recordApplied(mark(9), "model:1")).toBe(false);
    expect(await store.projectionApplied(mark(2))).toBe(false);
  });

  it("never moves applied revision backwards", async () => {
    const store = createMemoryAuthorityProjectionStateStore();
    await store.markDirty(mark(5));
    expect(await store.recordApplied(mark(5), "model:1")).toBe(true);
    expect(await store.recordApplied(mark(2), "model:1")).toBe(false);
    expect(await store.projectionApplied(mark(5))).toBe(true);
  });

  it("denies when the authorization model id does not match", async () => {
    const store = createMemoryAuthorityProjectionStateStore();
    await store.markDirty(mark(1));
    expect(await store.recordApplied(mark(1), "model:old")).toBe(true);
    expect(await store.projectionApplied(mark(1), "model:old")).toBe(true);
    expect(await store.projectionApplied(mark(1), "model:pinned")).toBe(false);
  });

  it("keeps the projection dirty after a recorded error", async () => {
    const store = createMemoryAuthorityProjectionStateStore();
    await store.markDirty(mark(2));
    expect(await store.recordError(mark(2), "openfga unavailable")).toBe(true);
    expect(await store.projectionApplied(mark(2))).toBe(false);
  });

  it("raises committed revision on dirty without lowering applied", async () => {
    const store = createMemoryAuthorityProjectionStateStore();
    await store.markDirty(mark(2));
    expect(await store.recordApplied(mark(2), "model:1")).toBe(true);
    await store.markDirty(mark(5));
    expect(await store.projectionApplied(mark(5))).toBe(false);
    expect(await store.projectionApplied(mark(2))).toBe(true);
  });
});
