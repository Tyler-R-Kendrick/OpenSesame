// The unit tests a pull-request diff has to run.
//
// A package a diff reaches used to run its whole suite: ten minutes for Pages
// on a runner, for a diff that touched a handful of files. A diff now runs
//
//   - the tests that import what changed, transitively (`vitest related`), and
//   - the tests that read the filesystem or spawn a tool (the structural
//     contracts: the capability ledger, the docs checks, the design lint). An
//     import graph cannot see what a test reads by path, so these always run.
//
// and the package's whole suite when the diff can change what every test runs
// on: a manifest, a config, the lockfile, or anything the test setup imports.
// When this file cannot tell, it runs the whole suite. A wrong skip is worse
// than one extra run.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const CODE = /\.(?:[cm]?[jt]sx?|json|css|html)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);
// A test that reads by path or runs a tool: its subject is not in its imports.
const STRUCTURAL =
  /\bfrom\s+["'](?:node:)?(?:fs|child_process)(?:\/promises)?["']|\brequire\(\s*["'](?:node:)?(?:fs|child_process)["']\s*\)/;
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
// `import type` and `export type ... from` are erased before a test runs.
const TYPE_ONLY = /\b(?:import|export)\s+type\b[^;]*?from\s*["'][^"']+["'];?/gs;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx", ".json"];

/**
 * The `vitest run` a package's `test` script is, and the rest of its chain.
 * @returns {{ rest: string | undefined } | null} null when the script is not
 *   plain vitest (it is then run whole, by its own script)
 */
export function vitestScript(script) {
  const match = /^vitest run(?: --maxWorkers=\d+)?(?: && (.+))?$/.exec(
    script ?? "",
  );
  return match ? { rest: match[1] } : null;
}

/** A path whose change can alter how every test of a package runs. */
export function isInfraPath(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    name === "package.json" ||
    name === "pnpm-lock.yaml" ||
    name === "pnpm-workspace.yaml" ||
    name === "turbo.json" ||
    /^tsconfig(\..+)?\.json$/.test(name) ||
    /^vite(st)?\.(?:[\w-]+\.)?config\.[cm]?[jt]s$/.test(name) ||
    /^vitest\.[\w.-]+\.[cm]?[jt]s$/.test(name)
  );
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), visit);
    } else {
      visit(join(dir, entry.name));
    }
  }
}

/** Tests of a package that read the filesystem or spawn a tool, package-relative. */
export function structuralTests(root, dir) {
  const base = join(root, dir);
  const found = [];
  walk(base, (file) => {
    if (!TEST_FILE.test(file)) return;
    if (STRUCTURAL.test(readFileSync(file, "utf8"))) {
      found.push(file.slice(base.length + 1).replaceAll("\\", "/"));
    }
  });
  return found.sort();
}

// --- what every test of a package imports, through its setup ---------------

/** The `setupFiles` a package's vite/vitest config names, repo-relative. */
export function setupFiles(root, dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    if (!/^vite(st)?\.config\.[cm]?[jt]s$/.test(name)) continue;
    const text = readFileSync(join(root, dir, name), "utf8");
    const list = /setupFiles:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? "";
    for (const spec of list.matchAll(/["']([^"']+)["']/g)) {
      out.push(posix.normalize(`${dir}/${spec[1]}`));
    }
  }
  return out;
}

function resolveFile(root, base) {
  for (const ext of EXTENSIONS) {
    const file = `${base}${ext}`;
    if (existsSync(join(root, file)) && /\.[a-z]+$/.test(file)) return file;
  }
  // TypeScript's ESM spelling: a `.js` specifier names a `.ts` source.
  const stripped = base.replace(/\.[cm]?js$/, "");
  if (stripped !== base) {
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
      if (existsSync(join(root, `${stripped}${ext}`)))
        return `${stripped}${ext}`;
    }
  }
  for (const index of ["index.ts", "index.tsx", "index.js"]) {
    if (existsSync(join(root, base, index))) return `${base}/${index}`;
  }
  return undefined;
}

/** The repo-relative file an import specifier names, or undefined. */
function resolveSpec(root, file, spec) {
  let base;
  if (spec.startsWith(".")) {
    base = posix.normalize(`${dirname(file)}/${spec}`);
  } else if (spec.startsWith("@opensesame/")) {
    const [, name, ...sub] = spec.split("/");
    base = `packages/${name}/src${sub.length > 0 ? `/${sub.join("/")}` : "/index"}`;
  } else {
    return null;
  }
  return resolveFile(root, base);
}

/**
 * The files a package's test setup imports, transitively, and whether every
 * import could be followed. A workspace import `@opensesame/x/y.js` is read as
 * `packages/x/src/y`; any other bare name is a dependency, not a source file.
 * A type-only import is not followed: it is gone before the setup runs, so the
 * file it names cannot change what any test runs on.
 */
export function setupClosure(root, dir) {
  const files = new Set();
  let complete = true;
  const queue = setupFiles(root, dir);
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    if (!existsSync(join(root, file))) {
      complete = false;
      continue;
    }
    const text = readFileSync(join(root, file), "utf8").replace(TYPE_ONLY, "");
    for (const match of text.matchAll(IMPORT)) {
      const resolved = resolveSpec(root, file, match[1]);
      if (resolved === null) continue;
      if (resolved === undefined) complete = false;
      else queue.push(resolved);
    }
  }
  return { files, complete };
}

// --- hubs ------------------------------------------------------------------

/** A changed file more tests than this reach is a hub, not a subject. */
export const HUB_TESTS = 50;
/** How far from a hub's own file its tests are followed. */
export const HUB_DEPTH = 2;

/** importee -> the files that import it, over every workspace package's source. */
export function reverseImports(root, nodes) {
  const reverse = new Map();
  for (const node of nodes) {
    if (!existsSync(join(root, node.dir))) continue;
    walk(join(root, node.dir), (abs) => {
      if (!/\.[cm]?[jt]sx?$/.test(abs)) return;
      const file = abs.slice(root.length + 1).replaceAll("\\", "/");
      for (const match of readFileSync(abs, "utf8").matchAll(IMPORT)) {
        const target = resolveSpec(root, file, match[1]);
        if (!target) continue;
        const from = reverse.get(target) ?? new Set();
        from.add(file);
        reverse.set(target, from);
      }
    });
  }
  return reverse;
}

/** Non-test source files, anywhere in the workspace, that read the filesystem. */
function fsReaders(root, reverse) {
  const files = new Set();
  for (const importers of reverse.values()) {
    for (const file of importers) files.add(file);
  }
  return [...files].filter(
    (file) =>
      !TEST_FILE.test(file) &&
      /\.[cm]?[jt]sx?$/.test(file) &&
      STRUCTURAL.test(readFileSync(join(root, file), "utf8")),
  );
}

/**
 * The tests under `dir` that reach `file`, by import, with how many steps away
 * the nearest of each is. Unbounded `depth` finds every one.
 */
export function testsReaching(
  reverse,
  file,
  dir,
  depth = Number.POSITIVE_INFINITY,
) {
  const seen = new Set([file]);
  const found = new Set();
  let frontier = [file];
  for (let step = 1; step <= depth && frontier.length > 0; step += 1) {
    const next = [];
    for (const current of frontier) {
      for (const importer of reverse.get(current) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        if (TEST_FILE.test(importer) && importer.startsWith(`${dir}/`)) {
          found.add(importer);
        }
        next.push(importer);
      }
    }
    frontier = next;
  }
  return found;
}

// --- the plan -------------------------------------------------------------

/** Whether a path is something a test could import or read as data. */
function isInput(path) {
  return CODE.test(path);
}

/** A snapshot changed without its test: the test is what runs. */
function testOfSnapshot(path) {
  if (!path.endsWith(".snap")) return undefined;
  return path.replace("/__snapshots__/", "/").replace(/\.snap$/, "");
}

/**
 * How each affected package runs its tests for a diff.
 *
 * `mode` is `full` (its own `test` script, whole), or `scoped` (what `related`
 * and `structural` name). `extra` is the rest of a `vitest run && ...` chain,
 * which runs only when the diff reached it.
 *
 * @param {{ root: string, nodes: {name: string, dir: string}[],
 *   packages: string[], paths: string[], isDoc: (path: string) => boolean }} input
 *   `paths` are every changed path, deleted ones included.
 */
export function planUnitTests({ root, nodes, packages, paths, isDoc }) {
  const changed = paths.filter((path) => path !== "" && !isDoc(path));
  const infra = changed.some(isInfraPath);
  const related = [];
  for (const path of changed) {
    const test = testOfSnapshot(path);
    const target = test ?? path;
    if (isInput(target) && existsSync(join(root, target))) related.push(target);
  }
  let reverse;
  let readers;
  return packages.map((name) => {
    const node = nodes.find((candidate) => candidate.name === name);
    if (node === undefined) throw new Error(`no workspace package ${name}`);
    const pkg = JSON.parse(
      readFileSync(join(root, node.dir, "package.json"), "utf8"),
    );
    const script = pkg.scripts?.test;
    if (script === undefined) return { name, dir: node.dir, mode: "none" };
    const parsed = vitestScript(script);
    if (parsed === null)
      return {
        name,
        dir: node.dir,
        mode: "full",
        why: "its test script is not plain vitest",
      };
    if (infra)
      return {
        name,
        dir: node.dir,
        mode: "full",
        why: "a manifest, config or lockfile changed",
      };
    const closure = setupClosure(root, node.dir);
    if (!closure.complete) {
      return {
        name,
        dir: node.dir,
        mode: "full",
        why: "its test setup could not be followed",
      };
    }
    const touched = changed.find((path) => closure.files.has(path));
    if (touched !== undefined) {
      return {
        name,
        dir: node.dir,
        mode: "full",
        why: `${touched} is imported by every test's setup`,
      };
    }
    const underPackage = (path) => path.startsWith(`${node.dir}/`);
    // `vitest related` follows every import, so one change to a file the whole
    // suite leans on selects the whole suite. A hub's tests are followed a few
    // steps instead; the typecheck holds the rest of what it exports.
    reverse ??= reverseImports(root, nodes);
    const structural = new Set(structuralTests(root, node.dir));
    // A test that reads a file through a helper imports no `fs` itself, but
    // what it reads is not in its import graph either.
    readers ??= fsReaders(root, reverse);
    for (const file of readers) {
      for (const test of testsReaching(reverse, file, node.dir)) {
        structural.add(test.slice(node.dir.length + 1));
      }
    }
    const hubs = [];
    const direct = [];
    const hubTests = new Set();
    for (const file of related) {
      if (testsReaching(reverse, file, node.dir).size > HUB_TESTS) {
        hubs.push(file);
        for (const test of testsReaching(reverse, file, node.dir, HUB_DEPTH)) {
          hubTests.add(test.slice(node.dir.length + 1));
        }
      } else {
        direct.push(file);
      }
    }
    return {
      name,
      dir: node.dir,
      mode: "scoped",
      related: direct,
      hubs,
      hubTests: [...hubTests].sort(),
      structural: [...structural].sort(),
      extra: parsed.rest,
      // The chain after `vitest run` belongs to the package's own files.
      extraRuns: changed.some(underPackage),
    };
  });
}
