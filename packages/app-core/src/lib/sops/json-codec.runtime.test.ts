/** @vitest-environment node */
import { expect, it } from "vitest";
import { SopsError, type SopsErrorCode } from "./errors.js";
import { emitJsonTree, parseJsonTree } from "./json-codec.js";
import { MAX_KEY_LENGTH, MAX_SCALAR_BYTES } from "./limits.js";
import { type SopsNode, entry, scalarText } from "./model.js";

it("decodes JSON escapes and a real surrogate pair without changing scalar content", () => {
  const escaped = parseJsonTree(
    String.raw`{"value":"\"\\\/\b\f\n\r\t\uD83D\uDD10"}`,
  );
  expect(scalarText(entry(escaped, "value"))).toBe(
    ['"', "\\", "/", "\b", "\f", "\n", "\r", "\t", "🔐"].join(""),
  );
  expect(parseJsonTree(emitJsonTree(escaped))).toEqual(escaped);
});

it("preserves ordered numeric and prototype-named keys without prototype pollution", () => {
  const tree = parseJsonTree(
    '{"10":1,"2":2,"__proto__":{"safe":true},"constructor":null}',
  );
  if (tree.kind !== "map") throw new Error("expected an ordered object");
  const keys = tree.items.flatMap((item) =>
    item.kind === "entry" ? [item.key] : [],
  );
  expect(keys).toEqual(["10", "2", "__proto__", "constructor"]);
  expect(parseJsonTree(emitJsonTree(tree))).toEqual(tree);
  expect(Object.hasOwn(Object.prototype, "safe")).toBe(false);
});

function refusesDocument(text: string, code: SopsErrorCode): void {
  try {
    parseJsonTree(text);
  } catch (error) {
    if (!(error instanceof SopsError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  expect.fail("Malformed document was accepted.");
}

const malformed: readonly [string, SopsErrorCode][] = [
  [String.raw`{"a":"\q"}`, "invalid_document"],
  [String.raw`{"a":"\uZ123"}`, "invalid_document"],
  [String.raw`{"a":"\uD800"}`, "malformed_encoding"],
  [String.raw`{"a":"\uD800\u0041"}`, "malformed_encoding"],
  [String.raw`{"a":"\uDC00"}`, "malformed_encoding"],
  ['{"a":"raw\ncontrol"}', "invalid_document"],
  ['{"a":"unterminated}', "invalid_document"],
  ['{"a":trueX}', "invalid_document"],
  ['{"a":tru}', "invalid_document"],
  ['{"a":nul}', "invalid_document"],
  ['{"a" 1}', "invalid_document"],
  ['{"a":1;', "invalid_document"],
  ['{"a":1', "invalid_document"],
  ['{"a":[1;2]}', "invalid_document"],
  ['{"a":[1', "invalid_document"],
  ['{"a":-}', "invalid_document"],
  ['{"a":1.}', "invalid_document"],
  ['{"a":1e+}', "invalid_document"],
  ['{"a":1e309}', "unsupported_feature"],
  ['{"a":9223372036854775808}', "unsupported_feature"],
  ['{"a":-9223372036854775809}', "unsupported_feature"],
  ['{"a":1} trailing', "invalid_document"],
  ["[1,2]", "invalid_document"],
  [String.raw`{"same":1,"sa\u006de":2}`, "duplicate_key"],
];
it.each(malformed)(
  "refuses malformed or ambiguous document %s before encryption",
  (text, code) => {
    refusesDocument(text, code);
  },
);

it("retains exact int64 edges, float type, exponent values and both zero semantics", () => {
  const tree = parseJsonTree(
    '{"min":-9223372036854775808,"max":9223372036854775807,"intZero":-0,"floatZero":-0.0,"float":1.0,"exponent":2.5e-3,"empty":[],"object":{}}',
  );
  expect(entry(tree, "min")).toEqual({
    kind: "scalar",
    scalar: { kind: "int", value: "-9223372036854775808" },
  });
  expect(entry(tree, "max")).toEqual({
    kind: "scalar",
    scalar: { kind: "int", value: "9223372036854775807" },
  });
  expect(entry(tree, "intZero")).toEqual({
    kind: "scalar",
    scalar: { kind: "int", value: "0" },
  });
  expect(entry(tree, "floatZero")).toEqual({
    kind: "scalar",
    scalar: { kind: "float", value: -0 },
  });
  expect(parseJsonTree(emitJsonTree(tree))).toEqual(tree);
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "refuses JSON emission of YAML's legitimate nonfinite scalar %s",
  (value) => {
    const tree: SopsNode = {
      kind: "map",
      items: [
        {
          kind: "entry",
          key: "value",
          value: { kind: "scalar", scalar: { kind: "float", value } },
        },
      ],
    };
    expect(() => emitJsonTree(tree)).toThrow(/infinite or NaN/);
  },
);

it("enforces independent key and scalar limits while accepting their exact boundary", () => {
  const key = "k".repeat(MAX_KEY_LENGTH);
  const scalar = "v".repeat(MAX_SCALAR_BYTES);
  expect(
    scalarText(entry(parseJsonTree(JSON.stringify({ [key]: scalar })), key)),
  ).toBe(scalar);
  for (const document of [
    JSON.stringify({ [`${key}x`]: "small" }),
    JSON.stringify({ value: `${scalar}x` }),
  ]) {
    refusesDocument(document, "resource_limit");
  }
});
