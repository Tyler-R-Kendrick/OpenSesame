import { describe, expect, it } from "vitest";
import {
  type LoaderTable,
  assertKnown,
  entries,
  isLoaderTable,
  modulesFor,
} from "./loader-table.js";

const TABLE: LoaderTable = {
  generatedAt: "2026-01-01T00:00:00.000Z",
  entries: [
    {
      id: "vault.items.search",
      moduleIds: ["mod.vault.items.search"],
      assetIds: ["a1"],
    },
    {
      id: "vault.items.reveal",
      moduleIds: ["mod.vault.items.reveal"],
      assetIds: [],
    },
  ],
};

describe("loader table", () => {
  it("reads modules for known ids", () => {
    expect(modulesFor(TABLE, "vault.items.search")).toEqual([
      "mod.vault.items.search",
    ]);
    expect(entries(TABLE).size).toBe(2);
  });

  it("fails closed on unknown ids", () => {
    expect(() => assertKnown(TABLE, "ghost.cap")).toThrow(/no module for/);
    expect(() => modulesFor(TABLE, "ghost.cap")).toThrow();
  });

  it("rejects malformed tables", () => {
    expect(isLoaderTable(TABLE)).toBe(true);
    expect(isLoaderTable(null)).toBe(false);
    expect(isLoaderTable({ entries: [] })).toBe(true);
    expect(
      isLoaderTable({ entries: [{ id: "a", moduleIds: [], assetIds: [] }] }),
    ).toBe(false);
    expect(
      isLoaderTable({
        entries: [
          { id: "a", moduleIds: ["m"], assetIds: [] },
          { id: "a", moduleIds: ["m"], assetIds: [] },
        ],
      }),
    ).toBe(false);
  });
});
