import type { WorkerVariantRef } from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import {
  evictableCaches,
  isolated,
  ownsCache,
  variantCacheName,
} from "./sw-variants.js";

const A: WorkerVariantRef = {
  variantId: "v-a",
  moduleId: "mod.a" as never,
  planDigest: "digest-1",
  assetIds: ["a1"],
};
const B: WorkerVariantRef = {
  variantId: "v-b",
  moduleId: "mod.b" as never,
  planDigest: "digest-1",
  assetIds: ["b1"],
};

describe("worker variant cache isolation", () => {
  it("namespaces caches by variant and digest", () => {
    expect(variantCacheName(A)).toBe("variant:v-a:digest-1");
    expect(ownsCache(A, variantCacheName(A))).toBe(true);
    expect(ownsCache(A, variantCacheName(B))).toBe(false);
  });

  it("variant A cannot read variant B", () => {
    expect(isolated(A, variantCacheName(B))).toBe(false);
    expect(isolated(A, variantCacheName(A))).toBe(true);
  });

  it("evicts only owned stale caches, never the world", () => {
    const names = [
      "variant:v-a:digest-0",
      "variant:v-a:digest-1",
      "variant:v-b:digest-0",
      "opensesame-pages-v3",
      "other",
    ];
    expect(evictableCaches(A, names)).toEqual(["variant:v-a:digest-0"]);
  });
});
