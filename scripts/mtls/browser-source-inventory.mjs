import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const workflowFixture =
  "packages/app-core/src/lib/vault/password-workflows.test-support.ts";
const workflowAlias =
  "@opensesame/app-core/lib/vault/password-workflows.test-support.js";

function isTest(path) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /__tests__|\/test\//.test(path)
  );
}

function referencesFixture(root, path, specifier) {
  if (specifier === workflowAlias) return true;
  if (!specifier.startsWith(".")) return false;
  const target = resolve(root, dirname(path), specifier).replace(
    /\.[cm]?js$/,
    ".ts",
  );
  const fixture = resolve(root, workflowFixture);
  return target === fixture || `${target}.ts` === fixture;
}

/** Inspect real import syntax, including re-exports and dynamic imports. */
function importsFixture(root, path) {
  const text = readFileSync(join(root, path), "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  let found = false;
  function visit(node) {
    if (
      ts.isStringLiteralLike(node) &&
      referencesFixture(root, path, node.text) &&
      (ts.isImportDeclaration(node.parent) ||
        ts.isExportDeclaration(node.parent) ||
        ts.isCallExpression(node.parent))
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

/** This one Node-host fixture is excluded only while every importer is a test. */
export function assertWorkflowFixtureIsTestOnly(root) {
  const paths = globSync(
    "{apps,packages}/*/{src,entrypoints,runner,lib}/**/*.{ts,tsx,js,mjs}",
    {
      cwd: root,
    },
  ).sort();
  const importers = paths.filter((path) => importsFixture(root, path));
  const production = importers.filter((path) => !isTest(path));
  if (production.length) {
    throw new Error(
      `Test-only workflow fixture imported by production: ${production.join(", ")}`,
    );
  }
  return importers;
}

export function shippedSources(root, dir) {
  if (dir === "packages/app-core") assertWorkflowFixtureIsTestOnly(root);
  return globSync("src/**/*.{ts,tsx,js,mjs}", { cwd: join(root, dir) })
    .filter(
      (path) =>
        !isTest(path) &&
        !/^src\/node\//.test(path) &&
        join(dir, path) !== workflowFixture,
    )
    .sort();
}
