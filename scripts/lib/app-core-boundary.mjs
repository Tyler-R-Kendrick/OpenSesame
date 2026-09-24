/**
 * The app-core boundary (ADR 0133). Pure functions over a file map so they
 * can be tested without a checkout; scripts/app-core-boundary.mjs walks
 * packages/app-core/src and prints the report.
 *
 * The shared core runs in a browser tab, a CLI and a bare isolate, so it may
 * not reach into an app, load React, read Vite's `import.meta.env`, or import
 * a build-time virtual module — each of those is a port on the host instead.
 * Node's built-ins (`node:*`) are the Node host's alone (`src/node/**`) and
 * tests'. A type-only React import (`import type { ComponentType } from "react"`) is
 * erased at build time and loads nothing, so it is reported apart
 * (`reactTypes`) and does not fail the check: the contribution contract names
 * the shell's component type without calling React.
 */

const IMPORT_PATTERNS = [
  /(?:^|[\s;])import\s+(type\s+)?[^'";]*?\sfrom\s*["']([^"']+)["']/g,
  /(?:^|[\s;])import\s*["']([^"']+)["']/g,
  /(?:^|[\s;])export\s+(type\s+)?[^'";]*?\sfrom\s*["']([^"']+)["']/g,
  /import\(\s*["']([^"']+)["']\s*\)/g,
  /\bvi\.(?:mock|doMock|importActual)\(\s*["']([^"']+)["']/g,
];

/** Module specifiers a source file names, with whether each is type-only. */
export function parseImports(source) {
  const found = [];
  for (const [index, re] of IMPORT_PATTERNS.entries()) {
    for (const match of source.matchAll(re)) {
      const typed = index === 0 || index === 2;
      found.push({
        specifier: typed ? match[2] : match[1],
        typeOnly: typed && Boolean(match[1]),
      });
    }
  }
  return found;
}

/**
 * Test code and test support: may use Node, jsdom and anything a test runner
 * offers. Shared with the portability check.
 */
export const TEST_FILE =
  /(\.test\.|\/__tests__\/|\/test\/|\/doubles\/|\/fixtures\/|\.fixture\.|test-support|(^|\/)test-(host|setup)\.ts$)/;

/** Where the core may import Node's built-ins: the Node host, and tests. */
export function mayUseNode(path) {
  return path.startsWith("src/node/") || TEST_FILE.test(path);
}

const NODE_BUILTIN = /^node:/;

const REACT =
  /^(react|react-dom|react-router|react-router-dom|preact|@testing-library\/react|use-sync-external-store)(\/|$)/;

/**
 * Repo-level data the core may read by relative path: shared test fixtures and
 * the language-neutral contracts under spec/ (the connector parity table).
 * Anything else outside the package — above all an app — is a violation.
 */
const SHARED_DATA = ["spec/", "tests/fixtures/"];

/**
 * `from` is a path inside the package (`src/lib/x.ts`); returns the target's
 * path relative to the package root, with `../` segments where it leaves.
 */
export function resolveFromPackage(from, specifier) {
  const parts = from.split("/").slice(0, -1);
  let above = 0;
  for (const segment of specifier.replace(/[?#].*$/, "").split("/")) {
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      else above += 1;
    } else if (segment !== ".") parts.push(segment);
  }
  return `${"../".repeat(above)}${parts.join("/")}`;
}

/** Which report list an import belongs on, if any, and the edge to record. */
function classifyEdge(edge, packageName, packageDepth) {
  const { from, to: specifier, typeOnly } = edge;
  if (NODE_BUILTIN.test(specifier))
    return mayUseNode(from) ? null : { kind: "nodeImports", edge };
  if (REACT.test(specifier))
    return { kind: typeOnly ? "reactTypes" : "react", edge };
  if (specifier.startsWith("virtual:")) return { kind: "virtual", edge };
  if (specifier === packageName || specifier.startsWith(`${packageName}/`))
    return { kind: "selfImports", edge };
  if (!specifier.startsWith(".")) return null;
  const target = resolveFromPackage(from, specifier);
  if (!target.startsWith("../")) return null;
  const fromRepo =
    target.split("../").length - 1 === packageDepth
      ? target.slice("../".repeat(packageDepth).length)
      : null;
  if (fromRepo && SHARED_DATA.some((dir) => fromRepo.startsWith(dir)))
    return null;
  return { kind: "escapes", edge: { ...edge, to: fromRepo ?? target } };
}

/**
 * @param {Map<string, string>} files  package-relative path -> source
 * @param {{ packageName: string, packageDepth: number }} options
 *   `packageDepth` is how many directories the package root sits below the
 *   repo root (2 for `packages/app-core`).
 */
export function findViolations(files, { packageName, packageDepth }) {
  const report = {
    escapes: [],
    react: [],
    reactTypes: [],
    viteEnv: [],
    virtual: [],
    selfImports: [],
    nodeImports: [],
  };
  for (const [path, source] of files) {
    if (source.includes("import.meta.env")) report.viteEnv.push(path);
    for (const { specifier, typeOnly } of parseImports(source)) {
      const edge = { from: path, to: specifier, typeOnly };
      const found = classifyEdge(edge, packageName, packageDepth);
      if (found) report[found.kind].push(found.edge);
    }
  }
  return report;
}

/** Everything but `reactTypes` fails the check. */
export function blockingCount(report) {
  return (
    report.escapes.length +
    report.react.length +
    report.viteEnv.length +
    report.virtual.length +
    report.selfImports.length +
    (report.nodeImports?.length ?? 0)
  );
}
