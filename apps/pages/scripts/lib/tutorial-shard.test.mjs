import { describe, expect, it } from "vitest";
import { inShard, isFirstShard, parseShard } from "./tutorial-shard.mjs";

const ids = Array.from({ length: 120 }, (_, i) => `area.tutorial-${i}`);

describe("tutorial shards", () => {
  it("is one whole shard when unset", () => {
    expect(parseShard(undefined)).toEqual({ index: 1, count: 1 });
    expect(parseShard("")).toEqual({ index: 1, count: 1 });
    expect(ids.every((id) => inShard(id, parseShard(undefined)))).toBe(true);
  });

  it("reads k/n and refuses anything else", () => {
    expect(parseShard("2/3")).toEqual({ index: 2, count: 3 });
    for (const bad of ["0/3", "4/3", "1", "a/b", "1/0", "1/3/5", " 1/3"]) {
      expect(() => parseShard(bad), bad).toThrow(/TUTORIALS_SHARD/);
    }
  });

  it("puts every tutorial in exactly one shard, and spreads them", () => {
    const shards = [1, 2, 3].map((index) => parseShard(`${index}/3`));
    for (const id of ids) {
      expect(shards.filter((shard) => inShard(id, shard))).toHaveLength(1);
    }
    for (const shard of shards) {
      const held = ids.filter((id) => inShard(id, shard)).length;
      expect(held).toBeGreaterThan(20);
      expect(held).toBeLessThan(60);
    }
  });

  it("does not move a tutorial when the library grows", () => {
    const shard = parseShard("2/3");
    const before = ids.filter((id) => inShard(id, shard));
    const after = [...ids, "late.one", "late.two"].filter((id) =>
      inShard(id, shard),
    );
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("names the first shard as the one that also runs the non-tutorial passes", () => {
    expect(isFirstShard(parseShard("1/3"))).toBe(true);
    expect(isFirstShard(parseShard("2/3"))).toBe(false);
    expect(isFirstShard(parseShard(undefined))).toBe(true);
  });
});
