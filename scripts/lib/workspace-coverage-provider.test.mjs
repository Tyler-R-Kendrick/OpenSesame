import native from "@vitest/coverage-v8";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";
import { expect, it, vi } from "vitest";
import definition, {
  PINNED_COVERAGE_VERSION,
  SparseWorkspaceCoverageProvider,
  fillOwnerInventory,
} from "./workspace-coverage-provider.mjs";

function providerState() {
  const workspaceIncludes = ["/workspace/packages/*/src/**/*.ts"];
  const ownIncludes = ["src/**/*.ts"];
  return {
    options: {
      include: workspaceIncludes,
      exclude: ["**/*.test.ts"],
      allowExternal: true,
    },
    ownIncludes,
    globCache: new Map([["old-cache", true]]),
    ownerFillActive: false,
  };
}

it("delegates the exact pinned native inspector hooks, without a fallback collector", async () => {
  expect(definition.startCoverage).toBe(native.startCoverage);
  expect(definition.takeCoverage).toBe(native.takeCoverage);
  expect(definition.stopCoverage).toBe(native.stopCoverage);
  const provider = await definition.getProvider();
  expect(provider).toBeInstanceOf(SparseWorkspaceCoverageProvider);
  expect(provider.version).toBe(PINNED_COVERAGE_VERSION);
  expect(() => provider.initialize({ version: "4.1.10" })).toThrow(
    "Unsupported native V8 coverage interface",
  );
});

it("walks only the owner's complete include patterns and restores exact workspace options/cache", async () => {
  const provider = providerState();
  const options = provider.options;
  const includes = options.include;
  const files = await fillOwnerInventory(
    provider,
    ["already-covered.ts"],
    async (tested) => {
      expect(provider.options.include).toBe(provider.ownIncludes);
      expect(provider.options.exclude).toEqual(["**/*.test.ts"]);
      expect(provider.globCache.size).toBe(0);
      expect(tested).toEqual(["already-covered.ts"]);
      provider.globCache.set("temporary-owner-result", false);
      return ["own-unexecuted.ts"];
    },
  );
  expect(files).toEqual(["own-unexecuted.ts"]);
  expect(provider.options).toBe(options);
  expect(provider.options.include).toBe(includes);
  expect(provider.globCache.size).toBe(0);
  expect(provider.ownerFillActive).toBe(false);
});

it("restores owner-fill options and cache after a real asynchronous failure", async () => {
  const provider = providerState();
  const includes = provider.options.include;
  await expect(
    fillOwnerInventory(provider, [], async () => {
      await Promise.resolve();
      provider.globCache.set("temporary", true);
      throw new Error("walker failed");
    }),
  ).rejects.toThrow("walker failed");
  expect(provider.options.include).toBe(includes);
  expect(provider.globCache.size).toBe(0);
  expect(provider.ownerFillActive).toBe(false);
});

it("refuses concurrent owner walks without corrupting the original pending walk", async () => {
  const provider = providerState();
  const includes = provider.options.include;
  let complete;
  const waiting = new Promise((resolve) => {
    complete = resolve;
  });
  const first = fillOwnerInventory(provider, [], () => waiting);
  await expect(
    fillOwnerInventory(provider, [], async () => []),
  ).rejects.toThrow("Concurrent owner coverage fill");
  expect(provider.options.include).toBe(provider.ownIncludes);
  complete(["owner.ts"]);
  await expect(first).resolves.toEqual(["owner.ts"]);
  expect(provider.options.include).toBe(includes);
  expect(provider.ownerFillActive).toBe(false);
});

it("calls the original public native source walker with the original tested-file list", async () => {
  const provider = new SparseWorkspaceCoverageProvider();
  Object.assign(provider, providerState());
  const original = vi
    .spyOn(
      Object.getPrototypeOf(V8CoverageProvider.prototype),
      "getUntestedFiles",
    )
    .mockResolvedValue(["owner.ts"]);
  try {
    await expect(provider.getUntestedFiles(["tested.ts"])).resolves.toEqual([
      "owner.ts",
    ]);
    expect(original).toHaveBeenCalledExactlyOnceWith(["tested.ts"]);
  } finally {
    original.mockRestore();
  }
});
