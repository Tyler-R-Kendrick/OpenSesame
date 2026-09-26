import { describe, expect, it } from "vitest";
import { isJsonObject, isString, readString } from "./json-boundary.mjs";

describe("json-boundary", () => {
  it("tells strings from everything else", () => {
    expect(isString("a")).toBe(true);
    expect(isString("")).toBe(true);
    for (const value of [1, null, undefined, {}, [], new String("a")]) {
      expect(isString(value)).toBe(false);
    }
    expect(readString("x")).toBe("x");
    expect(readString(3)).toBeUndefined();
  });

  it("accepts plain objects only", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
    for (const value of [null, [], "x", 1, () => 1, async () => 1]) {
      expect(isJsonObject(value)).toBe(false);
    }
  });
});
