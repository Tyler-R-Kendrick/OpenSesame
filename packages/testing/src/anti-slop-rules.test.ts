import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The vendored anti-slop Oxlint plugin ships 13 RuleTester suites under
 * `tools/oxlint/anti-slop`. Nothing ran them: `tools/` has no package.json and
 * is not in pnpm-workspace.yaml, so neither `pnpm test` (turbo, per-package)
 * nor any vitest config ever reached them. They are also not vitest suites —
 * `RuleTester.run` asserts at import time rather than registering `it` blocks,
 * so pointing vitest straight at them reports "No test suite found".
 *
 * Importing each file inside a test gives them a home in a package that
 * already runs, without editing vendored files (the install-anti-slop skill
 * reinstalls them) or adding tools/ to the workspace.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "../../../tools/oxlint/anti-slop");

async function ruleSuites(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await ruleSuites(full)));
    } else if (entry.name.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found.sort();
}

const suites = await ruleSuites(PLUGIN_ROOT);

describe("vendored anti-slop rule suites", () => {
  it("finds the plugin's suites", () => {
    // Guards the glob itself: a silently empty list would make every
    // assertion below vacuous, which is how these went unrun in the first place.
    expect(suites.length).toBeGreaterThanOrEqual(13);
  });

  it.each(suites.map((file) => [path.relative(PLUGIN_ROOT, file), file]))(
    "%s",
    async (_name, file) => {
      // RuleTester throws on a failing valid/invalid case during import.
      await expect(import(pathToFileURL(file).href)).resolves.toBeDefined();
    },
  );
});
