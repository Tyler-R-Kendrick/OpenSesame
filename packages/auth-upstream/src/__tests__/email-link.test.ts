import { describe, expect, it } from "vitest";
import { noEmailAutoLinkPolicy } from "../email-link.js";
import { MemoryPrincipalMappingStore } from "../mapping.js";
import {
  createProvisionalPrincipal,
  upgradeProvisionalToUpstream,
} from "../provisional.js";

describe("email auto-link", () => {
  it("policy never auto-links by email", () => {
    expect(noEmailAutoLinkPolicy.autoLinkByEmail).toBe(false);
    expect(noEmailAutoLinkPolicy.shouldAutoLinkOnEmail("a@b.co")).toBe(false);
    expect(
      noEmailAutoLinkPolicy.canMergeByEmailAlone(
        { email: "same@example.com", principalId: "a" },
        { email: "same@example.com", principalId: "b" },
      ),
    ).toBe(false);
  });

  it("does not merge two principals that share an email", async () => {
    const store = new MemoryPrincipalMappingStore();
    const a = await createProvisionalPrincipal(store);
    const b = await createProvisionalPrincipal(store);

    await upgradeProvisionalToUpstream(store, {
      principalId: a.mapping.principalId,
      betterAuthUserId: "ba_a",
      upstreamProviderId: "mock",
      upstreamSubject: "sub-a",
      email: "shared@example.com",
    });

    await upgradeProvisionalToUpstream(store, {
      principalId: b.mapping.principalId,
      betterAuthUserId: "ba_b",
      upstreamProviderId: "mock",
      upstreamSubject: "sub-b",
      email: "shared@example.com",
    });

    const byEmail = await store.findByEmail("shared@example.com");
    // Store may retain last write for email index, but principals remain distinct.
    expect(a.mapping.principalId).not.toBe(b.mapping.principalId);
    const principalA = await store.findByPrincipalId(a.mapping.principalId);
    const principalB = await store.findByPrincipalId(b.mapping.principalId);
    expect(principalA?.principalId).toBe(a.mapping.principalId);
    expect(principalB?.principalId).toBe(b.mapping.principalId);
    expect(principalA?.principalId).not.toBe(principalB?.principalId);
    // Email lookup alone is not an auto-link decision surface.
    expect(
      noEmailAutoLinkPolicy.shouldAutoLinkOnEmail(byEmail?.email ?? ""),
    ).toBe(false);
  });
});
