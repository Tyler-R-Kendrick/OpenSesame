/**
 * The Pages → app-core partition (ADR 0133). Pure functions over a file map so
 * they can be tested without a checkout; scripts/app-core-partition.mjs walks
 * the tree and prints the report.
 *
 * A source file moves when it matches a `move` pattern and no `stay` pattern.
 * Once moved it lives in a package, and a package cannot import the app, so
 * every edge from moving code into staying code has to be gone before the
 * relocation. React is the same problem one step removed: the shared core runs
 * in Node and a bare isolate, where React has no business loading.
 */

/** Globs with `**` (any depth, including none) and `*` (within a segment). */
export function globToRegExp(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      pattern += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else {
      pattern += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function createClassifier(manifest) {
  const move = manifest.move.map(globToRegExp);
  const stay = manifest.stay.map(globToRegExp);
  return (path) =>
    move.some((re) => re.test(path)) && !stay.some((re) => re.test(path))
      ? "move"
      : "stay";
}

const IMPORT_PATTERNS = [
  /(?:^|[\s;])import\s+(type\s+)?[^'";]*?\sfrom\s*["']([^"']+)["']/g,
  /(?:^|[\s;])import\s*["']([^"']+)["']/g,
  /(?:^|[\s;])export\s+(type\s+)?[^'";]*?\sfrom\s*["']([^"']+)["']/g,
  /import\(\s*["']([^"']+)["']\s*\)/g,
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

const REACT = /^(react|react-dom|react-router|react-router-dom|preact)(\/|$)/;

function candidates(base) {
  if (/\.(js|mjs|jsx)$/.test(base)) {
    const stem = base.replace(/\.(js|mjs|jsx)$/, "");
    return [`${stem}.ts`, `${stem}.tsx`, base];
  }
  if (/\.[a-z]+$/i.test(base)) return [base];
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
}

/** Join within the root; a path that climbs out of it keeps a leading `../`. */
function joinPath(fromFile, specifier) {
  const parts = fromFile.split("/").slice(0, -1);
  let above = 0;
  for (const segment of specifier.split("/")) {
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      else above += 1;
    } else if (segment !== ".") parts.push(segment);
  }
  return `${"../".repeat(above)}${parts.join("/")}`;
}

/** Resolve a relative specifier against the file map; null for packages. */
export function resolveRelative(fromFile, specifier, files) {
  if (!specifier.startsWith(".")) return null;
  const base = joinPath(fromFile, specifier.replace(/\?.*$/, ""));
  return candidates(base).find((path) => files.has(path)) ?? base;
}

/**
 * @param {Map<string, string>} files  path (relative to root) -> source
 * @param {(path: string) => "move" | "stay"} classify
 */
export function findViolations(files, classify) {
  const crossings = [];
  const outside = [];
  const react = [];
  const viteEnv = [];
  for (const [path, source] of files) {
    if (classify(path) !== "move") continue;
    if (source.includes("import.meta.env")) viteEnv.push(path);
    for (const { specifier, typeOnly } of parseImports(source)) {
      if (REACT.test(specifier)) {
        react.push({ from: path, to: specifier, typeOnly });
        continue;
      }
      const target = resolveRelative(path, specifier, files);
      if (target === null) continue;
      const edge = { from: path, to: target, typeOnly };
      if (target.startsWith("../")) outside.push(edge);
      else if (classify(target) === "move") continue;
      else if (target.endsWith(".tsx")) react.push(edge);
      else crossings.push(edge);
    }
  }
  return { crossings, outside, react, viteEnv };
}
