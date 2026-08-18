import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertExclusiveClaim, assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { MemoryPrincipalMappingStore } from "../mapping.js";
import {
  createProvisionalPrincipal,
  upgradeProvisionalToUpstream,
} from "../provisional.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — provisional upgrade", () => {
  it("source: upgrade refuses email auto-link", () => {
    assertSourceOrder(readFileSync(join(here, "../provisional.ts"), "utf8"), [
      "export async function upgradeProvisionalToUpstream",
      "findByUpstream",
      "already linked to a different principal",
      "do NOT merge with findByEmail",
    ]);
  });

  it("property: principalId is stable across upgrade", async () => {
    const store = new MemoryPrincipalMappingStore();
    const { mapping } = await createProvisionalPrincipal(store);
    const upgraded = await upgradeProvisionalToUpstream(store, {
      principalId: mapping.principalId,
      betterAuthUserId: "ba_user",
      upstreamProviderId: "mock",
      upstreamSubject: "sub-1",
    });
    expect(upgraded.principalId).toBe(mapping.principalId);
    expect(upgraded.provisional).toBe(false);
  });

  it("chaos: concurrent upgrades of two provisionals to one upstream keep a single winner", async () => {
    const store = new MemoryPrincipalMappingStore();
    const many = await Promise.all(
      Array.from({ length: 16 }, () => createProvisionalPrincipal(store)),
    );
    await assertExclusiveClaim(async () => {
      const next = many.pop();
      if (!next) return false;
      try {
        await upgradeProvisionalToUpstream(store, {
          principalId: next.mapping.principalId,
          betterAuthUserId: next.mapping.betterAuthUserId,
          upstreamProviderId: "mock",
          upstreamSubject: "same-sub",
        });
        return true;
      } catch {
        return false;
      }
    }, 16);
    const linked = await store.findByUpstream("mock", "same-sub");
    expect(linked).toBeDefined();
  });
});
