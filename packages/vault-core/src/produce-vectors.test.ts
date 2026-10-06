import { describe, expect, it } from "vitest";
import fixture from "../../../spec/conformance/produce-vectors.json" with {
  type: "json",
};
import { deriveCharacters } from "./derive.js";
import { splitAtPepper } from "./pepper-position.js";

describe("the golden produce vectors", () => {
  it.each(fixture.derived)(
    "computes $name as recorded",
    ({ root, counter, rules, password }) => {
      expect(deriveCharacters(root, counter, rules)).toBe(password);
    },
  );

  it.each(fixture.positions.cases)(
    "puts a pepper at `$expression` as recorded",
    ({ expression, head, tail }) => {
      expect(splitAtPepper(fixture.positions.password, expression)).toEqual({
        head,
        tail,
      });
    },
  );

  it("holds a distinct password for each root and counter it records", () => {
    const first = fixture.derived.slice(0, 3).map((entry) => entry.password);
    expect(new Set(first).size).toBe(3);
  });
});
