// @vitest-environment node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";

// A fresh native module graph keeps Vitest/setup imports from warming Zod's
// cache or initializing its global configuration before the probe.
const PROBE = `
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
let probes = 0;
globalThis.Function = new Proxy(globalThis.Function, {
  construct() {
    probes += 1;
    throw new EvalError("Content Security Policy forbids eval");
  },
});
if (process.argv[2]) runInThisContext(readFileSync(process.argv[2], "utf8"));
const { z } = await import(process.argv[1]);
const parsed = z.object({ name: z.string() }).parse({ name: "Ada" });
console.log(JSON.stringify({ probes, parsed }));
`;

function probe(withBootstrap) {
  // App-core owns the browser's Zod 4 dependency; Pages also resolves Zod 3.
  const appRequire = createRequire(
    new URL("../../../packages/app-core/package.json", import.meta.url),
  );
  const zod = pathToFileURL(
    appRequire.resolve("zod").replace(/index\.cjs$/, "index.js"),
  ).href;
  const args = ["--input-type=module", "--eval", PROBE, zod];
  if (withBootstrap)
    args.push(
      fileURLToPath(
        new URL("../public/browser-schema-config.js", import.meta.url),
      ),
    );
  return JSON.parse(
    execFileSync(process.execPath, args, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
    }),
  );
}

test("the classic bootstrap prevents Zod's eval probe before the module graph", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const bootstrap =
    '<script src="%BASE_URL%browser-schema-config.js"></script>';
  assert.ok(html.includes(bootstrap));
  assert.ok(html.indexOf(bootstrap) < html.indexOf('type="module"'));
  assert.ok(probe(false).probes > 0, "the unconfigured module probes eval");
  assert.deepEqual(probe(true), { probes: 0, parsed: { name: "Ada" } });
});
