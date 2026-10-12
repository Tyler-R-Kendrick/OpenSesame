import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import vectors from "../../../../../spec/conformance/secret-file-layout-vectors.json" with {
  type: "json",
};
import { checkPath } from "./files.js";
import { secretFilePath, slugSegment } from "./layout.js";

describe("the layout of a secret's file", () => {
  for (const vector of vectors.secretFilePath) {
    it(vector.why, () => {
      const path = secretFilePath(
        {
          folder: vector.folder,
          name: vector.name,
          kind: vector.kind,
          id: vector.id,
        },
        new Set(vector.held),
      );
      expect(path).toBe(vector.path);
      // Whatever it names, every store accepts it.
      expect(Effect.runSync(checkPath(path))).toBe(path);
    });
  }

  for (const vector of vectors.slugSegment) {
    it(`slugs ${JSON.stringify(vector.input)}`, () => {
      expect(slugSegment(vector.input)).toBe(vector.slug);
    });
  }

  it("never produces a path a store refuses, whatever it is given", () => {
    const hostile = [
      "..",
      ".",
      "a/../b",
      "con",
      "x.part",
      "\u0000",
      "💥",
      " ",
      "/",
      "\\",
      "COM1.txt",
      "a".repeat(500),
    ];
    for (const name of hostile) {
      for (const folder of [null, name, `${name}/${name}`]) {
        const path = secretFilePath(
          { folder, name, kind: name, id: "x" },
          new Set(),
        );
        expect(Effect.runSync(checkPath(path))).toBe(path);
      }
    }
  });

  it("keeps two secrets with one name apart however many collide", () => {
    const held = new Set<string>();
    for (const id of ["aaaaaaaa-1", "aaaaaaaa-2", "aaaaaaaa-3"]) {
      const path = secretFilePath(
        { folder: null, name: "same", kind: "note", id },
        held,
      );
      expect(held.has(path)).toBe(false);
      held.add(path);
    }
    expect(held.size).toBe(3);
  });
});
