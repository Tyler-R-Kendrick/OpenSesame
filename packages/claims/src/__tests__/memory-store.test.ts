import { type ClaimSession, fixtures } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { ClaimEngine, MemoryClaimStore } from "../index.js";

function ghostSession(id: string): ClaimSession {
  return {
    id,
    type: "project",
    state: "pending",
    tokenDigest: new Uint8Array(0),
    targetManifest: { a: 1 },
    targetManifestDigest: "sha256:ghost",
    createdAt: fixtures.now,
    expiresAt: new Date(fixtures.now.getTime() + 600_000),
    version: 1,
  };
}

describe("MemoryClaimStore", () => {
  it("rejects creating a claim whose id already exists", async () => {
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store: new MemoryClaimStore(),
      clock: () => fixtures.now,
    });
    const input = {
      type: "project" as const,
      targetManifest: { a: 1 },
      publicId: "pub_duplicate",
    };
    await eng.createClaim(input);
    await expect(eng.createClaim(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("throws NOT_FOUND when swapping a claim that does not exist", async () => {
    const store = new MemoryClaimStore();
    await expect(
      store.compareAndSwap("clm_ghost", 1, ghostSession("clm_ghost")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a swap that changes the immutable manifest digest", async () => {
    const store = new MemoryClaimStore();
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: () => fixtures.now,
    });
    const created = await eng.createClaim({
      type: "project",
      targetManifest: { a: 1 },
    });
    const current = await store.get(created.session.id);
    if (!current) throw new Error("claim missing");
    await expect(
      store.compareAndSwap(created.session.id, current.version, {
        ...current,
        targetManifestDigest: "sha256:tampered",
      }),
    ).rejects.toMatchObject({ code: "IMMUTABLE_FIELD" });
    // The stored row must be untouched.
    expect((await store.get(created.session.id))?.targetManifestDigest).toBe(
      current.targetManifestDigest,
    );
  });

  it("loses the swap when the expected version is stale", async () => {
    const store = new MemoryClaimStore();
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: () => fixtures.now,
    });
    const created = await eng.createClaim({
      type: "project",
      targetManifest: { a: 1 },
    });
    const current = await store.get(created.session.id);
    if (!current) throw new Error("claim missing");
    const result = await store.compareAndSwap(created.session.id, 99, {
      ...current,
      version: current.version + 1,
    });
    expect(result.won).toBe(false);
    expect(result.session.version).toBe(current.version);
  });

  it("returns an empty item list for unknown claims", async () => {
    const store = new MemoryClaimStore();
    expect(await store.getItems("clm_ghost")).toEqual([]);
  });

  it("round-trips items written through putItems", async () => {
    const store = new MemoryClaimStore();
    const items = fixtures.claimItems("clm_items");
    await store.putItems("clm_items", items);
    const fetched = await store.getItems("clm_items");
    expect(fetched.map((item) => item.id)).toEqual([
      "ci_project",
      "ci_resource",
    ]);
  });

  it("hands out defensive copies so callers cannot mutate stored rows", async () => {
    const store = new MemoryClaimStore();
    const eng = new ClaimEngine({
      pepper: fixtures.pepper,
      store,
      clock: () => fixtures.now,
    });
    const created = await eng.createClaim({
      type: "resource_bundle",
      targetManifest: { a: 1 },
      items: fixtures.claimItems("placeholder"),
    });

    const session = await store.get(created.session.id);
    if (!session) throw new Error("claim missing");
    session.state = "revoked";
    expect((await store.get(created.session.id))?.state).toBe("pending");

    const items = await store.getItems(created.session.id);
    const first = items[0];
    if (!first) throw new Error("items missing");
    first.state = "accepted";
    const stored = await store.getItems(created.session.id);
    expect(stored[0]?.state).toBe("pending");
  });
});
