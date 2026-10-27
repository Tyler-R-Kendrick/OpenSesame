import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileRecipeStore, MemoryRecipeStore } from "./recipe-store.js";
import { run } from "./test-support.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cua-recipes-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("per-domain recipe store", () => {
  it("keeps independent domains and never replays a candidate implicitly", async () => {
    const store = new MemoryRecipeStore();
    const recipe = { ...run().recipe, review: "candidate" as const };
    await store.put(recipe);
    expect((await store.get(recipe.domain))?.review).toBe("candidate");
    expect(await store.get("other.example.test")).toBeUndefined();
  });

  it("atomically persists a domain recipe", async () => {
    const store = await FileRecipeStore.open(directory);
    await store.put(run().recipe);
    expect(await store.get(run().recipe.domain)).toEqual(run().recipe);
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(await readdir(join(directory))).toHaveLength(1);
  });
});
