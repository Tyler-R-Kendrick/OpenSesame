import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const quotePath = path.join(
  root,
  "node_modules/.pnpm/shell-quote@1.11.0/node_modules/shell-quote/package.json",
);
const mapPath = path.join(
  root,
  "node_modules/.pnpm/source-map-js@1.2.2/node_modules/source-map-js/package.json",
);
const quoteRequire = createRequire(quotePath);
const mapRequire = createRequire(mapPath);
assert.equal(quoteRequire(quotePath).version, "1.11.0");
assert.equal(mapRequire(mapPath).version, "1.2.2");
const { quote } = quoteRequire("shell-quote");
const { SourceMapConsumer, SourceNode } = mapRequire("source-map-js");

test("shell-quote refuses a later token that escapes a comment through a line terminator", () => {
  for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
    assert.throws(
      () => quote(["echo", "ok", { comment: "x" }, `a${terminator}id;#`]),
      { name: "TypeError" },
    );
  }
  assert.equal(quote(["echo", "hello world"]), "echo 'hello world'");
  assert.equal(
    quote(["echo", "ok", { comment: "ordinary" }]),
    "echo ok #ordinary",
  );
});

function indexed(line) {
  return {
    version: 3,
    sections: [
      {
        offset: { line, column: 0 },
        map: {
          version: 3,
          sources: ["a.js"],
          sourcesContent: ["hello"],
          names: [],
          mappings: "AAAA",
        },
      },
    ],
  };
}

test("source-map-js rejects the oversized section before synchronous SourceNode iteration", () => {
  assert.throws(
    () => new SourceMapConsumer(indexed(1e12)),
    /Section offset line must not exceed/,
  );
  const consumer = new SourceMapConsumer(indexed(2));
  const source = SourceNode.fromStringWithSourceMap(
    "one\ntwo\nhello",
    consumer,
  );
  assert.equal(source.toString(), "one\ntwo\nhello");
});
