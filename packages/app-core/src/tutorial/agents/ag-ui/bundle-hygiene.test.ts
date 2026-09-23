/** @vitest-environment node */
/**
 * Two properties that are only true while nobody breaks them, and that no type
 * can express — so they are read out of the source.
 *
 * The needles are assembled from fragments rather than written out, because a
 * test that contains the string it forbids is a test that fails on itself.
 * Prose may name the library; only a *quoted* occurrence is a module
 * specifier, and every one of those has to be a dynamic import.
 *
 * Node rather than jsdom: this case reads files, and under jsdom
 * `import.meta.url` is an http URL with no path on disk behind it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGES_SRC = fileURLToPath(new URL("../../../", import.meta.url));

const CONSOLE_CALL = `${"con"}${"sole"}.`;
const AG_UI_SPECIFIER = `${"@ag-ui"}${"/client"}`;
const QUOTED_SPECIFIER = new RegExp(
  `(["'])${AG_UI_SPECIFIER.replaceAll("/", "\\/")}\\1`,
  "g",
);
const DYNAMIC_IMPORT_TAIL = /import\(\s*$/;

function typescriptFilesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules") continue;
      found.push(...typescriptFilesIn(path));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) found.push(path);
  }
  return found;
}

/** Quoted occurrences of the specifier that are not `import("…")`. */
function staticSpecifiers(source: string): number {
  let statics = 0;
  for (const match of source.matchAll(QUOTED_SPECIFIER)) {
    const before = source.slice(0, match.index);
    if (!DYNAMIC_IMPORT_TAIL.test(before)) statics += 1;
  }
  return statics;
}

function dynamicSpecifiers(source: string): number {
  let dynamics = 0;
  for (const match of source.matchAll(QUOTED_SPECIFIER)) {
    const before = source.slice(0, match.index);
    if (DYNAMIC_IMPORT_TAIL.test(before)) dynamics += 1;
  }
  return dynamics;
}

describe("bundle hygiene", () => {
  it("logs nothing anywhere in this directory", () => {
    const offenders: string[] = [];
    for (const path of typescriptFilesIn(HERE)) {
      if (readFileSync(path, "utf8").includes(CONSOLE_CALL)) {
        offenders.push(path.slice(HERE.length));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names the library as a module specifier only in a dynamic import", () => {
    const offenders: string[] = [];
    for (const path of typescriptFilesIn(PAGES_SRC)) {
      if (staticSpecifiers(readFileSync(path, "utf8")) > 0) {
        offenders.push(path.slice(PAGES_SRC.length));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps that one dynamic import, so the rule above is not vacuous", () => {
    const total = typescriptFilesIn(PAGES_SRC).reduce(
      (count, path) => count + dynamicSpecifiers(readFileSync(path, "utf8")),
      0,
    );
    expect(total).toBe(1);
    expect(
      dynamicSpecifiers(readFileSync(join(HERE, "transport.ts"), "utf8")),
    ).toBe(1);
  });

  it("keeps the exported surface free of AG-UI and rxjs type names", () => {
    const barrel = readFileSync(join(HERE, "index.ts"), "utf8");
    for (const leaked of [
      "BaseEvent",
      "RunAgentInput",
      "HttpAgent",
      "Observable",
      "AbstractAgent",
      "AgentSubscriber",
    ]) {
      expect(barrel.includes(`${leaked},`)).toBe(false);
    }
  });
});
