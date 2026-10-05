/**
 * Every runtime produces a password through the one facade (ADR 0174): copy to
 * the clipboard, fill, the terminal, the agent and browser surfaces, health and
 * export all ask `producePassword` in `@opensesame/vault-core` and none of them
 * knows how a password is made. This fails when any other production module
 * opens an algorithm, a pepper seal or a pepper position itself.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** The techniques only the facade (and the one-time conversion) may touch. */
const TECHNIQUES =
  /\b(deriveCharacters|splitAtPepper|openWithPepper|sphinxPassword|plainPassword|accountPlainPassword|needsPepper)\b/u;

/** Where those techniques live: the facade and what it is built from. */
const HOMES = new Set([
  "packages/vault-core/src/derive.ts",
  "packages/vault-core/src/pepper-position.ts",
  "packages/vault-core/src/pepper-seal.ts",
  "packages/vault-core/src/produce.ts",
  // The one-time conversion of what an older version sealed (ADR 0174 §5).
  "packages/app-core/src/lib/vault/generators/legacy.ts",
  "packages/app-core/src/lib/vault/generators/sphinx.ts",
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (
      name === "node_modules" ||
      name === "dist" ||
      name.startsWith("dist-")
    ) {
      return [];
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs)$/u.test(name) &&
      !/\.test\.|\.test-support\.|\.fixture\./u.test(name)
      ? [path]
      : [];
  });
}

describe("the password facade", () => {
  it("is the only production code that opens an algorithm, a pepper seal or a pepper position", () => {
    const roots = [
      "packages/vault-core/src",
      "packages/app-core/src",
      "packages/cli/src",
      "packages/mcp-host/src",
      "packages/mcp-client/src",
      "packages/sdk-browser/src",
      "packages/capability-registry/src",
      "apps/pages/src",
      "apps/browser-extension/entrypoints",
    ];
    const offenders = roots
      .flatMap((root) => sources(join(REPO, root)))
      .map((path) => relative(REPO, path))
      .filter((path) => !HOMES.has(path))
      .filter((path) =>
        TECHNIQUES.test(readFileSync(join(REPO, path), "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});
