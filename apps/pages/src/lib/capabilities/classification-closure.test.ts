import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify } from "./classification.js";

/**
 * `shared` code "must never import optional feature code"
 * (`classification.ts`). A hardened build that keeps one optional capability
 * and excludes another emitted the excluded one's files under its own name
 * when a shared file reached them (`build:profile --all`, enterprise-selected),
 * and a selective build put two capabilities in one chunk. The gate that
 * catches it is a full Pages build per profile; this is the same rule read off
 * the source, so a new import fails here in seconds.
 */

const repo = path.resolve(__dirname, "../../../../..");
const ROOTS = ["apps/pages/src", "packages/app-core/src"];
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) {
      if (name !== "node_modules" && name !== "__tests__")
        sourceFiles(file, out);
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.(test|fixture|test-support|test-harness)\./.test(name)
    ) {
      out.push(file);
    }
  }
  return out;
}

/** The path the classification rules are written against (relative to apps/pages). */
function ruleRelative(file: string): string {
  const rel = path.relative(repo, file);
  if (rel.startsWith("apps/pages/")) return rel.slice("apps/pages/".length);
  return `src/${rel.slice("packages/app-core/src/".length)}`;
}

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith(".")
    ? path.resolve(path.dirname(from), specifier)
    : specifier.startsWith("@opensesame/app-core/")
      ? path.join(
          repo,
          "packages/app-core/src",
          specifier.slice("@opensesame/app-core/".length),
        )
      : null;
  if (base === null) return null;
  const stem = base.replace(/\.js$/, "");
  for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (existsSync(stem + suffix)) return stem + suffix;
  }
  return null;
}

describe("shared code owns no optional feature", () => {
  it("imports no file an optional capability owns", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(path.join(repo, root))) {
        if (classify(ruleRelative(file))?.classification !== "shared") continue;
        for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
          const specifier = match[1];
          if (specifier === undefined) continue;
          const target = resolveImport(file, specifier);
          // A capability's runtime module is reached through the module table.
          if (target === null || target.includes("/modules/")) continue;
          const owner = classify(ruleRelative(target));
          if (owner?.classification === "optional" && owner.capability)
            offenders.push(
              `${path.relative(repo, file)} -> ${owner.capability} ${path.relative(repo, target)}`,
            );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
