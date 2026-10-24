import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  evaluationOrder,
  forbidsEval,
  jitlessOrderProblem,
} from "./zod-jitless-order.mjs";

// Minified shapes, as Rollup emits them: zod's constructors keep their names
// as strings, and the jitless switch is one assignment on the shared config.
const ZOD = 'const t=r("$ZodType",(e,n)=>{});';
const SCHEMA = "const s=t.object({a:t.string()});";
const JITLESS =
  "function z(e=globalThis){e.__zod_globalConfig??={},e.__zod_globalConfig.jitless=!0}z();";

function page(chunks) {
  return {
    staticImports: (file) => chunks[file]?.imports ?? [],
    codeOf: (file) => chunks[file]?.code ?? "",
  };
}

describe("the order a page evaluates its chunks in", () => {
  test("is each import's own imports first, then the import, then the entry", () => {
    const { staticImports } = page({
      "main.js": { imports: ["a.js", "b.js"] },
      "a.js": { imports: ["c.js"] },
      "b.js": { imports: ["c.js"] },
    });
    assert.deepEqual(evaluationOrder("main.js", staticImports), [
      "c.js",
      "a.js",
      "b.js",
      "main.js",
    ]);
  });
});

describe("zod is jitless before a page evaluates any of zod", () => {
  test("passes when the jitless chunk is the first the page evaluates", () => {
    const { staticImports, codeOf } = page({
      "main.js": { imports: ["jitless.js", "zod.js", "schemas.js"], code: "" },
      "jitless.js": { code: JITLESS },
      "zod.js": { code: ZOD },
      "schemas.js": { imports: ["zod.js"], code: SCHEMA },
    });
    assert.equal(jitlessOrderProblem("main.js", staticImports, codeOf), null);
  });

  test("names zod's chunk and the switch's when zod is evaluated first", () => {
    const { staticImports, codeOf } = page({
      "main.js": { imports: ["schemas.js", "jitless.js"], code: "" },
      "schemas.js": { imports: ["zod.js"], code: SCHEMA },
      "zod.js": { code: ZOD },
      "jitless.js": { code: JITLESS },
    });
    assert.deepEqual(jitlessOrderProblem("main.js", staticImports, codeOf), {
      entry: "main.js",
      zod: "zod.js",
      jitless: "jitless.js",
    });
  });

  test("fails when the switch is only set in the entry's own body", () => {
    // The entry's body runs after every chunk it imports, so a call there is
    // too late: this is the shape a boot that calls zodJitless() itself has.
    const { staticImports, codeOf } = page({
      "main.js": { imports: ["schemas.js"], code: JITLESS },
      "schemas.js": { imports: ["zod.js"], code: SCHEMA },
      "zod.js": { code: ZOD },
    });
    assert.deepEqual(jitlessOrderProblem("main.js", staticImports, codeOf), {
      entry: "main.js",
      zod: "zod.js",
      jitless: "main.js",
    });
  });

  test("fails when a page that loads zod never sets the switch", () => {
    const { staticImports, codeOf } = page({
      "main.js": { imports: ["zod.js"], code: "" },
      "zod.js": { code: ZOD },
    });
    assert.deepEqual(jitlessOrderProblem("main.js", staticImports, codeOf), {
      entry: "main.js",
      zod: "zod.js",
      jitless: null,
    });
  });

  test("passes when only chunks without zod run before the switch", () => {
    const { staticImports, codeOf } = page({
      "main.js": {
        imports: ["noble.js", "jitless.js", "schemas.js"],
        code: "",
      },
      "noble.js": { code: "export const h=1;" },
      "jitless.js": { code: JITLESS },
      "schemas.js": { imports: ["zod.js"], code: SCHEMA },
      "zod.js": { code: ZOD },
    });
    assert.equal(jitlessOrderProblem("main.js", staticImports, codeOf), null);
  });

  test("passes when zod's own chunk sets the switch before its code", () => {
    const { staticImports, codeOf } = page({
      "main.js": { imports: ["schemas.js"], code: "" },
      "schemas.js": { imports: ["zod.js"], code: SCHEMA },
      "zod.js": { code: `${JITLESS}${ZOD}` },
    });
    assert.equal(jitlessOrderProblem("main.js", staticImports, codeOf), null);
  });

  test("fails when zod's own chunk sets the switch after its code", () => {
    const { staticImports, codeOf } = page({
      "main.js": { imports: ["schemas.js"], code: "" },
      "schemas.js": { imports: ["zod.js"], code: SCHEMA },
      "zod.js": { code: `${ZOD}${JITLESS}` },
    });
    assert.deepEqual(jitlessOrderProblem("main.js", staticImports, codeOf), {
      entry: "main.js",
      zod: "zod.js",
      jitless: "zod.js",
    });
  });

  test("has nothing to say about a page that loads no zod", () => {
    const { staticImports, codeOf } = page({
      "redirect.js": { imports: ["small.js"], code: "location.replace('/')" },
      "small.js": { code: "export const a=1;" },
    });
    assert.equal(
      jitlessOrderProblem("redirect.js", staticImports, codeOf),
      null,
    );
  });
});

describe("a page whose CSP forbids eval", () => {
  const meta = (policy) =>
    `<head><meta\n      http-equiv="Content-Security-Policy"\n      content="${policy}"\n    /></head>`;

  test("is one whose script-src leaves out 'unsafe-eval'", () => {
    assert.equal(
      forbidsEval(
        meta("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'"),
      ),
      true,
    );
  });

  test("falls back to default-src when there is no script-src", () => {
    assert.equal(forbidsEval(meta("default-src 'self'")), true);
  });

  test("is not one that allows eval, or that has no policy at all", () => {
    assert.equal(forbidsEval(meta("script-src 'self' 'unsafe-eval'")), false);
    assert.equal(forbidsEval(meta("img-src 'self'")), false);
    assert.equal(forbidsEval("<head><title>Signing in</title></head>"), false);
  });
});
