/**
 * The app-core boundary (ADR 0133). Pure functions over a file map so they
 * can be tested without a checkout; scripts/app-core-boundary.mjs walks
 * packages/app-core/src and prints the report.
 *
 * The shared core runs in a browser tab, a CLI and a bare isolate, so it may
 * not reach into an app, load React, read Vite's `import.meta.env`, or import
 * a build-time virtual module — each of those is a port on the host instead.
 * A type-only React import (`import type { ComponentType } from "react"`) is
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

const REACT =
  /^(react|react-dom|react-router|react-router-dom|preact|@testing-library\/react|use-sync-external-store)(\/|$)/;

/**
 * Repo-level data the core may read by relative path: shared fixtures and
 * the connector parity table. Anything else outside the package — above all
 * an app — is a violation.
 */
const SHARED_DATA = ["connectors/", "fixtures/"];

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

/**
 * @param {Map<string, string>} files  package-relative path -> source
 * @param {{ packageName: string, packageDepth: number }} options
 *   `packageDepth` is how many directories the package root sits below the
 *   repo root (2 for `packages/app-core`).
 */
export function findViolations(files, { packageName, packageDepth }) {
  const escapes = [];
  const react = [];
  const reactTypes = [];
  const viteEnv = [];
  const virtual = [];
  const selfImports = [];
  for (const [path, source] of files) {
    if (source.includes("import.meta.env")) viteEnv.push(path);
    for (const { specifier, typeOnly } of parseImports(source)) {
      const edge = { from: path, to: specifier, typeOnly };
      if (REACT.test(specifier)) {
        (typeOnly ? reactTypes : react).push(edge);
      } else if (specifier.startsWith("virtual:")) {
        virtual.push(edge);
      } else if (
        specifier === packageName ||
        specifier.startsWith(`${packageName}/`)
      ) {
        selfImports.push(edge);
      } else if (specifier.startsWith(".")) {
        const target = resolveFromPackage(path, specifier);
        if (!target.startsWith("../")) continue;
        const fromRepo =
          target.split("../").length - 1 === packageDepth
            ? target.slice("../".repeat(packageDepth).length)
            : null;
        if (fromRepo && SHARED_DATA.some((dir) => fromRepo.startsWith(dir)))
          continue;
        escapes.push({ ...edge, to: fromRepo ?? target });
      }
    }
  }
  return { escapes, react, reactTypes, viteEnv, virtual, selfImports };
}

/** Everything but `reactTypes` fails the check. */
export function blockingCount(report) {
  return (
    report.escapes.length +
    report.react.length +
    report.viteEnv.length +
    report.virtual.length +
    report.selfImports.length
  );
}
