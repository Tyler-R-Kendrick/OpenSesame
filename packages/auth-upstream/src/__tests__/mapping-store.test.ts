import { describe, expect, it } from "vitest";
import { MemoryPrincipalMappingStore } from "../mapping.js";
import type { PrincipalMapping } from "../mapping.js";

function mapping(overrides: Partial<PrincipalMapping> = {}): PrincipalMapping {
  return {
    principalId: "prn_1",
    betterAuthUserId: "ba_1",
    provisional: true,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("MemoryPrincipalMappingStore", () => {
  it("round-trips mappings through every index", async () => {
    const store = new MemoryPrincipalMappingStore();
    const saved = await store.save(
      mapping({
        upstreamProviderId: "mock",
        upstreamSubject: "sub-1",
        email: "User@Example.com",
      }),
    );

    expect(await store.findByBetterAuthUserId("ba_1")).toBe(saved);
    expect(await store.findByPrincipalId("prn_1")).toBe(saved);
    expect(await store.findByUpstream("mock", "sub-1")).toBe(saved);
    // Email index is case-insensitive.
    expect(await store.findByEmail("user@example.com")).toBe(saved);
  });

  it("returns undefined for unknown lookups", async () => {
    const store = new MemoryPrincipalMappingStore();
    expect(await store.findByBetterAuthUserId("nope")).toBeUndefined();
    expect(await store.findByPrincipalId("nope")).toBeUndefined();
    expect(await store.findByUpstream("mock", "nope")).toBeUndefined();
    expect(await store.findByEmail("nope@example.com")).toBeUndefined();
  });

  it("refuses to link one upstream identity to two principals", async () => {
    const store = new MemoryPrincipalMappingStore();
    await store.save(
      mapping({
        upstreamProviderId: "mock",
        upstreamSubject: "shared-sub",
      }),
    );

    await expect(
      store.save(
        mapping({
          principalId: "prn_2",
          betterAuthUserId: "ba_2",
          upstreamProviderId: "mock",
          upstreamSubject: "shared-sub",
        }),
      ),
    ).rejects.toThrow(
      "Upstream identity already linked to a different principal",
    );
    // The original link is untouched by the failed save.
    expect(
      (await store.findByUpstream("mock", "shared-sub"))?.principalId,
    ).toBe("prn_1");
  });

  it("allows re-saving the same principal against its own upstream link", async () => {
    const store = new MemoryPrincipalMappingStore();
    await store.save(
      mapping({
        upstreamProviderId: "mock",
        upstreamSubject: "sub-1",
      }),
    );
    const upgraded = await store.save(
      mapping({
        upstreamProviderId: "mock",
        upstreamSubject: "sub-1",
        provisional: false,
      }),
    );
    expect(upgraded.provisional).toBe(false);
  });

  it("keeps upstream keys distinct per provider for the same subject", async () => {
    const store = new MemoryPrincipalMappingStore();
    await store.save(
      mapping({ upstreamProviderId: "google", upstreamSubject: "sub-1" }),
    );
    await store.save(
      mapping({
        principalId: "prn_2",
        betterAuthUserId: "ba_2",
        upstreamProviderId: "github",
        upstreamSubject: "sub-1",
      }),
    );
    expect((await store.findByUpstream("google", "sub-1"))?.principalId).toBe(
      "prn_1",
    );
    expect((await store.findByUpstream("github", "sub-1"))?.principalId).toBe(
      "prn_2",
    );
  });

  it("saves mappings without upstream or email indexes", async () => {
    const store = new MemoryPrincipalMappingStore();
    await store.save(mapping());
    expect(await store.findByPrincipalId("prn_1")).toBeDefined();
    expect(await store.findByEmail("anything@example.com")).toBeUndefined();
  });
});

describe("MemoryPrincipalMappingStore.deleteProvisional", () => {
  it("removes a provisional mapping from every index", async () => {
    const store = new MemoryPrincipalMappingStore();
    await store.save(mapping({ email: "Gone@Example.com" }));

    expect(await store.deleteProvisional("prn_1")).toBe(true);
    expect(await store.findByPrincipalId("prn_1")).toBeUndefined();
    expect(await store.findByBetterAuthUserId("ba_1")).toBeUndefined();
    expect(await store.findByEmail("gone@example.com")).toBeUndefined();
  });

  it("refuses to delete an upgraded (non-provisional) principal", async () => {
    const store = new MemoryPrincipalMappingStore();
    await store.save(mapping({ provisional: false }));

    expect(await store.deleteProvisional("prn_1")).toBe(false);
    expect(await store.findByPrincipalId("prn_1")).toBeDefined();
  });

  it("returns false for an unknown principal", async () => {
    const store = new MemoryPrincipalMappingStore();
    expect(await store.deleteProvisional("prn_missing")).toBe(false);
  });

  it("deletes provisional mappings that have no email", async () => {
    const store = new MemoryPrincipalMappingStore();
    await store.save(mapping());

    expect(await store.deleteProvisional("prn_1")).toBe(true);
    expect(await store.findByPrincipalId("prn_1")).toBeUndefined();
  });
});
