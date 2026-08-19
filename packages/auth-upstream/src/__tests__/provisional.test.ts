import { describe, expect, it } from "vitest";
import { MemoryPrincipalMappingStore } from "../mapping.js";
import {
  createProvisionalPrincipal,
  upgradeProvisionalToUpstream,
} from "../provisional.js";

describe("createProvisionalPrincipal", () => {
  it("applies default ttl, quota profile, and allowed actions", async () => {
    const store = new MemoryPrincipalMappingStore();
    const { mapping, session } = await createProvisionalPrincipal(store);

    expect(mapping.principalId).toMatch(/^prn_/);
    expect(mapping.betterAuthUserId).toMatch(/^ba_anon_/);
    expect(session.id).toMatch(/^ps_[0-9a-f]{32}$/);
    expect(session.quotaProfile).toBe("anonymous");
    expect(session.allowedActions).toEqual(["claim.create", "browse"]);
    // Default TTL is 24h.
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(session.claimedAt).toBeUndefined();
    expect(session.revokedAt).toBeUndefined();

    // The mapping is persisted and findable.
    expect(await store.findByPrincipalId(mapping.principalId)).toBeDefined();
  });

  it("honors explicit ttl, quota profile, and allowed actions", async () => {
    const store = new MemoryPrincipalMappingStore();
    const { session } = await createProvisionalPrincipal(store, {
      ttlMs: 60_000,
      quotaProfile: "beta-tester",
      allowedActions: ["browse"],
    });

    expect(session.quotaProfile).toBe("beta-tester");
    expect(session.allowedActions).toEqual(["browse"]);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(
      60_000,
    );
  });
});

describe("upgradeProvisionalToUpstream error paths", () => {
  it("rejects an unknown principal", async () => {
    const store = new MemoryPrincipalMappingStore();
    await expect(
      upgradeProvisionalToUpstream(store, {
        principalId: "prn_missing",
        betterAuthUserId: "ba_x",
        upstreamProviderId: "mock",
        upstreamSubject: "sub-1",
      }),
    ).rejects.toThrow("Unknown principal: prn_missing");
  });

  it("rejects upgrading onto an upstream identity owned by another principal", async () => {
    const store = new MemoryPrincipalMappingStore();
    const a = await createProvisionalPrincipal(store);
    const b = await createProvisionalPrincipal(store);

    await upgradeProvisionalToUpstream(store, {
      principalId: a.mapping.principalId,
      betterAuthUserId: "ba_a",
      upstreamProviderId: "mock",
      upstreamSubject: "same-sub",
    });

    await expect(
      upgradeProvisionalToUpstream(store, {
        principalId: b.mapping.principalId,
        betterAuthUserId: "ba_b",
        upstreamProviderId: "mock",
        upstreamSubject: "same-sub",
      }),
    ).rejects.toThrow(
      "Upstream identity already linked to a different principal",
    );
    // The loser stays provisional.
    expect(
      (await store.findByPrincipalId(b.mapping.principalId))?.provisional,
    ).toBe(true);
  });

  it("re-upgrading the same principal onto its own upstream link is idempotent", async () => {
    const store = new MemoryPrincipalMappingStore();
    const { mapping } = await createProvisionalPrincipal(store);
    const input = {
      principalId: mapping.principalId,
      betterAuthUserId: "ba_user",
      upstreamProviderId: "mock",
      upstreamSubject: "sub-1",
    };
    await upgradeProvisionalToUpstream(store, input);
    const again = await upgradeProvisionalToUpstream(store, input);
    expect(again.provisional).toBe(false);
    expect(again.upstreamSubject).toBe("sub-1");
  });

  it("leaves email unset when the upgrade input omits it", async () => {
    const store = new MemoryPrincipalMappingStore();
    const { mapping } = await createProvisionalPrincipal(store);
    const upgraded = await upgradeProvisionalToUpstream(store, {
      principalId: mapping.principalId,
      betterAuthUserId: "ba_user",
      upstreamProviderId: "mock",
      upstreamSubject: "sub-1",
    });
    expect(upgraded.email).toBeUndefined();
    expect(upgraded.upgradedAt).toBeInstanceOf(Date);
  });
});
