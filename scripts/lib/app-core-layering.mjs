/**
 * The layering ledger for the shared core (ADR 0133). Pure functions over a
 * file map (package-relative path -> source) so they test without a checkout.
 *
 * Two rules. A cycle of static imports is a hard failure: modules in a
 * static cycle evaluate in an order nobody chose, and no package boundary
 * can ever be drawn through them. A lazy `import()` that closes a loop does
 * not tie evaluation together, so those edges are recorded instead — in
 * `layering-baseline.json` — and the ledger only shrinks: a new one fails,
 * and one that disappears must be struck from the ledger in the same change.
 */
import { TEST_FILE } from "./app-core-boundary.mjs";

const STATIC =
  /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*["'](\.[^"']+)["']/g;
const SIDE_EFFECT = /(?:^|[\n;])\s*import\s*["'](\.[^"']+)["']/g;
const DYNAMIC = /import\(\s*["'](\.[^"']+)["']\s*\)(\s*\.\s*[A-Za-z_])?/g;

function join(from, specifier) {
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function resolveIn(files, from, specifier) {
  const base = join(from, specifier.replace(/\.js$/, ".ts"));
  if (files.has(base)) return base;
  const index = base.replace(/\.ts$/, "/index.ts");
  return files.has(index) ? index : null;
}

/** `{ a, type b }` where every name is a type: erased like `import type`. */
function allTypes(clause) {
  const braces = clause.trim().match(/^\{([\s\S]*)\}$/);
  if (!braces) return false;
  const names = braces[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => name.startsWith("type "));
}

function edgesOf(files, path, source) {
  const edges = [];
  const add = (specifier, kind) => {
    const to = resolveIn(files, path, specifier);
    if (to) edges.push({ from: path, to, kind });
  };
  for (const m of source.matchAll(STATIC))
    add(m[4], m[2] || allTypes(m[3]) ? "type" : "static");
  for (const m of source.matchAll(SIDE_EFFECT)) add(m[1], "static");
  // `import("./x.js").T` is a type position; a bare `import(...)` loads.
  for (const m of source.matchAll(DYNAMIC))
    add(m[1], m[2] ? "type" : "dynamic");
  return edges;
}

/** Import edges between non-test modules of the map. */
export function importEdges(files) {
  const modules = new Map([...files].filter(([path]) => !TEST_FILE.test(path)));
  return [...modules].flatMap(([path, source]) =>
    edgesOf(modules, path, source),
  );
}

/** Strongly connected components of more than one module (Tarjan). */
export function cycles(edges, kinds) {
  const next = new Map();
  for (const { from, to, kind } of edges) {
    if (!kinds.includes(kind)) continue;
    if (!next.has(from)) next.set(from, []);
    next.get(from).push(to);
  }
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const found = [];
  let counter = 0;
  const visit = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    const component = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1) found.push(component.sort());
  };
  for (const v of next.keys()) if (!index.has(v)) visit(v);
  return found;
}

/**
 * `staticCycles`: each cycle of static value imports (must be none).
 * `lazyCycleEdges`: every `import()` edge whose ends share a cycle once lazy
 * edges count, as `from -> to`, sorted.
 */
export function layeringReport(files) {
  const edges = importEdges(files);
  const staticCycles = cycles(edges, ["static"]);
  const componentOf = new Map();
  for (const [n, component] of cycles(edges, ["static", "dynamic"]).entries())
    for (const path of component) componentOf.set(path, n);
  const lazyCycleEdges = [
    ...new Set(
      edges
        .filter(
          ({ from, to, kind }) =>
            kind === "dynamic" &&
            componentOf.has(from) &&
            componentOf.get(from) === componentOf.get(to),
        )
        .map(({ from, to }) => `${from} -> ${to}`),
    ),
  ].sort();
  return { staticCycles, lazyCycleEdges };
}

/** What changed against the recorded ledger. */
export function compareLedger(current, recorded) {
  const now = new Set(current);
  const then = new Set(recorded);
  return {
    added: current.filter((edge) => !then.has(edge)),
    removed: recorded.filter((edge) => !now.has(edge)),
  };
}
