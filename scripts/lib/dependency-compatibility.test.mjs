import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "vitest";

// Exercise the actual installed transitive consumer, not a separately resolved
// qs copy. Stryker is already a root development dependency.
const rootRequire = createRequire(
  new URL("../../package.json", import.meta.url),
);
const strykerRequire = createRequire(
  rootRequire.resolve("@stryker-mutator/core"),
);
const restRequire = createRequire(strykerRequire.resolve("typed-rest-client"));
const { getUrl } = restRequire("./Util.js");
const base = "https://example.invalid/report";

test("REST client's overridden qs preserves repeated arrays and value escaping", () => {
  assert.equal(
    getUrl(base, undefined, { params: { a: ["one", "two"], q: "x & y" } }),
    `${base}?a=one&a=two&q=x%20%26%20y`,
  );
});

test("REST client's overridden qs preserves explicit dotted object formatting", () => {
  assert.equal(
    getUrl(base, undefined, {
      params: { filter: { name: "a/b" } },
      options: { shouldAllowDots: true },
    }),
    `${base}?filter.name=a%2Fb`,
  );
});

test("REST client's overridden qs preserves bracket array formatting", () => {
  assert.equal(
    getUrl(base, undefined, {
      params: { a: ["x", "y"] },
      options: { arrayFormat: "brackets" },
    }),
    `${base}?a[]=x&a[]=y`,
  );
});

test("REST client's overridden qs distinguishes null, omitted, zero and false", () => {
  assert.equal(
    getUrl(base, undefined, {
      params: { empty: null, missing: undefined, n: 0, b: false },
    }),
    `${base}?empty=&n=0&b=false`,
  );
});
