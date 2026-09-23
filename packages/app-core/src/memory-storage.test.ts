import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./memory-storage.js";

describe("createMemoryStorage", () => {
  it("behaves like Web Storage", () => {
    const store = createMemoryStorage([["seed", "1"]]);
    expect(store.getItem("seed")).toBe("1");
    store.setItem("a", "x");
    expect(store.length).toBe(2);
    expect(store.key(1)).toBe("a");
    expect(store.key(2)).toBeNull();
    store.removeItem("seed");
    expect(store.getItem("seed")).toBeNull();
    expect(store.length).toBe(1);
  });

  it("keeps separate stores apart", () => {
    const one = createMemoryStorage();
    const two = createMemoryStorage();
    one.setItem("k", "v");
    expect(two.getItem("k")).toBeNull();
  });
});
