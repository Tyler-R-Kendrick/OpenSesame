/**
 * There is no Visual / Source toggle anywhere in the client (ADR 0134,
 * DESIGN.md "Settings is files"). A configuration is its form, or a file the
 * file viewer opens by `?file=`; a panel never draws a second representation
 * of itself beside its own form. This reads every non-test source file of
 * the shell and the core, so a toggle that comes back under a new name in a
 * new panel fails here, not in a screenshot.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = [here, join(here, "../../../packages/app-core/src")];
const SOURCE = /\.(ts|tsx|css)$/;
const SKIP = /\.test\.|\.d\.ts$|\/node_modules\/|\/dist\//;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return SOURCE.test(entry.name) && !SKIP.test(full) ? [full] : [];
  });
}

/** What the toggle was made of: its component, its mode type, its chrome. */
const REMNANTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a mode toggle component", /\bModeToggle\b/],
  ["an editor-mode type", /\bEditorMode\b|\bswitchDraftMode\b/],
  ["a source editor component", /\b\w*SourceEditor\b/],
  ["the toggle's classes", /\bcfg-(mode|source)\b/],
  ["the source textarea marker", /data-config-source/],
  ["the toggle's group label", /Editor representation/],
  ["a Visual or Source button", />\s*(Visual|Source|Effective)\s*</],
  ["a Save source key", /["']Save source["']/],
  [
    "a pressed Visual or Source choice",
    /aria-pressed=\{[^}]*["'](visual|source)["']/,
  ],
];

describe("no Visual / Source toggle", () => {
  it("is drawn by nothing in the shell or the core", () => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const path of files(root)) {
        const text = readFileSync(path, "utf8");
        for (const [what, pattern] of REMNANTS) {
          if (pattern.test(text))
            found.push(`${relative(root, path)}: ${what}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
