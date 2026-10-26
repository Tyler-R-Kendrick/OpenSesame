import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInThisContext } from "node:vm";

test("the classic bootstrap prevents Zod's eval probe before the module graph", async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const bootstrap =
    '<script src="%BASE_URL%browser-schema-config.js"></script>';
  assert.ok(html.includes(bootstrap));
  assert.ok(html.indexOf(bootstrap) < html.indexOf('type="module"'));
  const original = globalThis.Function;
  let probes = 0;
  globalThis.Function = new Proxy(original, {
    construct() {
      probes += 1;
      throw new EvalError("Content Security Policy forbids eval");
    },
  });
  try {
    runInThisContext(
      readFileSync(
        new URL("../public/browser-schema-config.js", import.meta.url),
        "utf8",
      ),
    );
    const { z } = await import("zod");
    assert.deepEqual(z.object({ name: z.string() }).parse({ name: "Ada" }), {
      name: "Ada",
    });
    assert.equal(probes, 0);
  } finally {
    globalThis.Function = original;
  }
});
