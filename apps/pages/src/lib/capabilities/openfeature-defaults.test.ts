/**
 * OF-04 lint: no Pages code may read a boolean flag with a `true` default,
 * and OF-05 structure: the SDK is reached only through the projection and
 * its facade — never from the loader, the authority check or the store.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "node_modules") continue;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts") && path !== THIS_FILE)
      out.push(path);
  }
  return out;
}

// Built from pieces so this file does not match its own pattern.
const BOOLEAN_READ = new RegExp(
  `${"getBoolean"}(?:Value|Details)\\(\\s*[^,()]+(?:\\([^)]*\\))?\\s*,\\s*${"true"}\\b`,
);
const SDK_IMPORT = /from\s+["']@openfeature\//;
const PROJECTION_IMPORT = /from\s+["']\.\/openfeature(?:-consumer)?\.js["']/;
const ALLOWED_SDK_FILES = new Set([
  "lib/capabilities/openfeature.ts",
  "lib/capabilities/openfeature-consumer.ts",
]);
/** The authority path: none of these may even see a flag value. */
const AUTHORITY_FILES = [
  "lib/capabilities/loader.ts",
  "lib/capabilities/authority.ts",
  "lib/capabilities/store.ts",
  "lib/capabilities/registry.ts",
  "lib/capabilities/lease.ts",
];

describe("OpenFeature usage rules", () => {
  const files = sourceFiles(SRC);

  it("OF-04: no boolean flag is read with a literal `true` default", () => {
    const offenders = files.filter((file) =>
      BOOLEAN_READ.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("OF-05: only the projection and its facade import the SDK", () => {
    const offenders = files
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .filter((file) => SDK_IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file))
      .filter((file) => !ALLOWED_SDK_FILES.has(file));
    expect(offenders).toEqual([]);
  });

  it("OF-05: the loader, authority, store, registry and lease never import a flag", () => {
    for (const name of AUTHORITY_FILES) {
      const source = readFileSync(join(SRC, name), "utf8");
      expect(PROJECTION_IMPORT.test(source), name).toBe(false);
      expect(SDK_IMPORT.test(source), name).toBe(false);
    }
  });
});
