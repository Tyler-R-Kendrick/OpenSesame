import { describe, expect, it } from "vitest";
import { MemoryPrincipalMappingStore } from "../mapping.js";
import {
  createProvisionalPrincipal,
  upgradeProvisionalToUpstream,
} from "../provisional.js";

describe("principal mapping", () => {
  it("preserves principal id on provisional → upstream upgrade", async () => {
    const store = new MemoryPrincipalMappingStore();
    const { mapping, session } = await createProvisionalPrincipal(store);

    expect(mapping.provisional).toBe(true);
    expect(session.principalId).toBe(mapping.principalId);

    const upgraded = await upgradeProvisionalToUpstream(store, {
      principalId: mapping.principalId,
      betterAuthUserId: "ba_user_upgraded",
      upstreamProviderId: "mock",
      upstreamSubject: "user-42",
      email: "user@example.com",
    });

    expect(upgraded.principalId).toBe(mapping.principalId);
    expect(upgraded.provisional).toBe(false);
    expect(upgraded.upstreamSubject).toBe("user-42");

    const byBa = await store.findByBetterAuthUserId("ba_user_upgraded");
    expect(byBa?.principalId).toBe(mapping.principalId);
  });
});
