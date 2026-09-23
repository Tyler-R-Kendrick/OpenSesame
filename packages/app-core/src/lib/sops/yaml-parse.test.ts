/** @vitest-environment node */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SopsError, type SopsErrorCode } from "./errors.js";
import type { SopsNode } from "./model.js";
import { goFloatText } from "./scalars.js";
import { emitYamlStream } from "./yaml-emit.js";
import { parseYamlDocuments } from "./yaml-parse.js";

const dir = join(__dirname, "fixtures", "tree");

/**
 * Inputs the pinned loader accepts but this engine refuses on purpose
 * (SB-018, SB-016, SB-009). Upstream converts an unknown tag or `!!binary`
 * to a string, keeps a merge key or an alias as data, loads a non-string
 * key that the walk then rejects, and yields a uint64 the walk rejects.
 */
const STRICTER: Record<string, SopsErrorCode> = {
  "custom-tag": "unsupported_feature",
  binary: "unsupported_feature",
  "merge-literal": "unsupported_feature",
  alias: "unsupported_feature",
  "nonstring-key": "unsupported_feature",
  uint64: "unsupported_feature",
  empty: "invalid_document",
};

type Dump =
  | { map: Dump[] }
  | { seq: Dump[] }
  | { comment: string; inline: boolean }
  | { key: string; value: Dump }
  | { str: string }
  | { int: string }
  | { float: string }
  | { bool: boolean }
  | { time: string }
  | { null: true };

function dump(node: SopsNode): Dump {
  switch (node.kind) {
    case "null":
      return { null: true };
    case "scalar": {
      const scalar = node.scalar;
      switch (scalar.kind) {
        case "str":
          return { str: scalar.value };
        case "int":
          return { int: scalar.value };
        case "float":
          return { float: goFloatText(scalar.value) };
        case "bool":
          return { bool: scalar.value };
        case "time":
          return { time: scalar.value };
        default: {
          const unreachable: never = scalar;
          return unreachable;
        }
      }
    }
    case "seq":
      return {
        seq: node.items.map((item) =>
          item.kind === "comment"
            ? { comment: item.value, inline: item.inline }
            : dump(item),
        ),
      };
    case "map":
      return {
        map: node.items.map((item) =>
          item.kind === "comment"
            ? { comment: item.value, inline: item.inline }
            : { key: item.key, value: dump(item.value) },
        ),
      };
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

describe("YAML parser against the pinned upstream loader (fixtures/tree)", () => {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => name.slice(0, -".yaml".length));
  expect(names.length).toBeGreaterThan(20);

  for (const name of names) {
    it(`matches upstream for ${name}`, () => {
      const text = readFileSync(join(dir, `${name}.yaml`), "utf8");
      const expected: { documents?: Dump[]; error?: string } = JSON.parse(
        readFileSync(join(dir, `${name}.tree.json`), "utf8"),
      );
      const stricter = STRICTER[name];
      if (stricter) {
        expect(() => parseYamlDocuments(text)).toThrowError(SopsError);
        try {
          parseYamlDocuments(text);
        } catch (caught) {
          expect(caught).toBeInstanceOf(SopsError);
          if (caught instanceof SopsError) expect(caught.code).toBe(stricter);
        }
        return;
      }
      if (expected.error !== undefined) {
        expect(() => parseYamlDocuments(text)).toThrowError(SopsError);
        return;
      }
      const roots = parseYamlDocuments(text);
      expect(roots.map(dump)).toEqual(expected.documents);
    });
  }

  it("emits YAML that parses back to the same tree, for every accepted fixture", () => {
    for (const name of names) {
      if (STRICTER[name]) continue;
      const text = readFileSync(join(dir, `${name}.yaml`), "utf8");
      let roots: SopsNode[];
      try {
        roots = parseYamlDocuments(text);
      } catch {
        continue;
      }
      const emitted = emitYamlStream(roots);
      const again = parseYamlDocuments(emitted);
      // Documented normalization: the emitter renders a comment whose text is
      // exactly one space as a bare `#`, which reads back as an empty comment.
      const normalize = (value: Dump): Dump =>
        "comment" in value && value.comment === " "
          ? { ...value, comment: "" }
          : value;
      const normalizeTree = (value: Dump): Dump => {
        if ("map" in value)
          return {
            map: value.map.map((item) =>
              "key" in item
                ? { key: item.key, value: normalizeTree(item.value) }
                : normalize(item),
            ),
          };
        if ("seq" in value)
          return {
            seq: value.seq.map((item) =>
              "comment" in item ? normalize(item) : normalizeTree(item),
            ),
          };
        return value;
      };
      expect(again.map(dump), name).toEqual(roots.map(dump).map(normalizeTree));
    }
  });
});
