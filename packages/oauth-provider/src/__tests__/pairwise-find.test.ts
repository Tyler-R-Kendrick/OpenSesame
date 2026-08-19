import { describe, expect, it } from "vitest";
import { MemoryPairwiseSubjectStore } from "../pairwise/store.js";

describe("MemoryPairwiseSubjectStore.find", () => {
  it("returns undefined before any mapping exists", async () => {
    const store = new MemoryPairwiseSubjectStore();
    await expect(
      store.find("principal-1", "sector-a"),
    ).resolves.toBeUndefined();
  });

  it("returns the stored mapping after getOrCreate", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const created = await store.getOrCreate("principal-1", "sector-a");

    const found = await store.find("principal-1", "sector-a");
    expect(found).toEqual(created);
    expect(found?.principalId).toBe("principal-1");
    expect(found?.sectorIdentifier).toBe("sector-a");
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it("scopes lookups to the exact principal + sector pair", async () => {
    const store = new MemoryPairwiseSubjectStore();
    await store.getOrCreate("principal-1", "sector-a");

    await expect(
      store.find("principal-2", "sector-a"),
    ).resolves.toBeUndefined();
    await expect(
      store.find("principal-1", "sector-b"),
    ).resolves.toBeUndefined();
  });
});
