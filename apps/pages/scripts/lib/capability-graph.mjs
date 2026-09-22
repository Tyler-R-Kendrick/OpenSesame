/**
 * Shared helpers for the capability build plugin and the post-build verifier:
 * module classification, entry closures over the emitted chunk graph, and the
 * JSON/HTML readers both sides use. Pure over plain data so the same rules run
 * inside Vite and again from disk. The forbidden-reachability rules themselves
 * (ownership.md §4.6) live in `capability-invariants.mjs`, which imports from
 * here — never the other way round.
 *
 * Graph shape (also `dist/capability-graph.json`):
 *   entries:  [{ html, capability, scripts: [file], preloads: [file] }]
 *   chunks:   [{ file, name, isEntry, isDynamicEntry, imports, dynamicImports,
 *                importedCss, importedAssets, modules: [{ id, classification,
 *                capability, rationale, size }] }]
 *   workers:  [{ variant, file, capability }]
 *   publicFiles: [{ file, capability }]
 *   moduleEdges: [{ from, to, kind: "static"|"dynamic", viaTable }]
 */
export {
  BUILD_MODES,
  IMPLICIT_PROFILE,
  InvalidProfileError,
  WORKER_VARIANTS,
  distributedCapabilities,
  distributionId,
  loadProfile,
  resolveBuildEnvironment,
} from "./capability-distribution.mjs";

export const VIRTUAL_MODULES = Object.freeze({
  table: "virtual:opensesame-capability-modules",
  distribution: "virtual:opensesame-distribution",
});

export const MODULES_DIR = "apps/pages/src/modules/";

const toPosix = (path) => path.replace(/\\/g, "/");

/**
 * Turn a Rollup module id into the repo-relative form the graph records:
 * `apps/pages/src/...`, `packages/...`, or `node_modules/<pkg>/...` (pnpm's
 * `.pnpm/<pkg>@<ver>/node_modules/` prefix removed). Virtual and `\0` ids
 * are kept verbatim minus the null byte.
 */
export function normalizeModuleId(id, { repoRoot }) {
  if (id.startsWith("\0")) return id.slice(1);
  if (id.startsWith("virtual:")) return id;
  const path = toPosix(id).replace(/[?#].*$/, "");
  const nodeModules = path.lastIndexOf("/node_modules/");
  if (nodeModules >= 0)
    return `node_modules/${path.slice(nodeModules + "/node_modules/".length)}`;
  const root = toPosix(repoRoot).replace(/\/$/, "");
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  // A workspace package reached through a symlinked checkout (a worktree, a
  // scratch copy) resolves to its real path: anchor on the workspace roots.
  const workspace = path.match(/\/(packages|apps|crates)\/[^/]+\//);
  if (workspace) return path.slice(workspace.index + 1);
  return path;
}

/** `apps/pages/src/modules/<cap>/...` → `<cap>`; a bare file there is not a module directory. */
export function moduleDirectoryOwner(normalized) {
  if (!normalized.startsWith(MODULES_DIR)) return null;
  const rest = normalized.slice(MODULES_DIR.length);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : null;
}

/**
 * Candidate strings a prefix rule may match: repo-relative, app-relative,
 * and — for a workspace package Vite resolved to its real `packages/<dir>/`
 * path — the `node_modules/@opensesame/<dir>/` spelling the authored rules
 * use, so one rule covers both resolutions.
 */
function matchCandidates(normalized) {
  const candidates = [normalized];
  if (normalized.startsWith("apps/pages/"))
    candidates.push(normalized.slice("apps/pages/".length));
  const workspace = normalized.match(/^packages\/([^/]+)\/(.*)$/);
  if (workspace)
    candidates.push(`node_modules/@opensesame/${workspace[1]}/${workspace[2]}`);
  return candidates;
}

/**
 * Same boundary rule as `classification.ts`'s `ruleMatches`: a prefix ending
 * in `/` or `-` matches anything under it; any other prefix matches the exact
 * path or a continuation by `.`, `-` or `/` (`src/lib/push` matches
 * `push.ts`, not `pushover.ts`).
 */
export function ruleMatches(pattern, path) {
  if (!path.startsWith(pattern)) return false;
  if (pattern.endsWith("/") || pattern.endsWith("-")) return true;
  const next = path.charAt(pattern.length);
  return next === "" || next === "." || next === "-" || next === "/";
}

const MODULES_DIR_PATTERNS = new Set([
  MODULES_DIR,
  "src/modules/",
  "src/modules",
]);

/**
 * Classify one module by the longest matching prefix rule. Rules are
 * `{ pattern: string | RegExp, classification, capability, rationale }`; a
 * RegExp rule is consulted only when no prefix rule matches. Under
 * `src/modules/` the directory name is the owner (§4.3), so a rule naming
 * the bare directory is ignored there; a rule naming a specific module
 * directory still wins, and `violations()` checks it (BUILD-06).
 */
/** The longest matching string-prefix rule, or null. */
function bestPrefixRule(rules, candidates, inModules) {
  let best = null;
  for (const rule of rules ?? []) {
    if (typeof rule.pattern !== "string") continue;
    const pattern = toPosix(rule.pattern);
    if (inModules && MODULES_DIR_PATTERNS.has(pattern)) continue;
    if (!candidates.some((c) => ruleMatches(pattern, c))) continue;
    if (best === null || pattern.length > best.pattern.length)
      best = { ...rule, pattern };
  }
  return best;
}

/** The first matching RegExp rule, consulted only when no prefix rule hit. */
function bestRegexRule(rules, candidates) {
  for (const rule of rules ?? []) {
    if (
      rule.pattern instanceof RegExp &&
      candidates.some((c) => rule.pattern.test(c))
    )
      return rule;
  }
  return null;
}

/** What a module is when no authored rule names it. */
function fallbackClassification(normalized, directoryOwner) {
  if (normalized.startsWith("node_modules/"))
    return {
      classification: "shared",
      capability: null,
      rationale: "unclassified dependency",
    };
  if (directoryOwner !== null)
    return {
      classification: "optional",
      capability: directoryOwner,
      rationale: "module directory",
    };
  if (normalized.startsWith("apps/pages/"))
    return {
      classification: "core",
      capability: null,
      rationale: "unclassified source",
    };
  return {
    classification: "shared",
    capability: null,
    rationale: "unclassified workspace package",
  };
}

export function classifyModule(id, rules, { repoRoot }) {
  const normalized = normalizeModuleId(id, { repoRoot });
  if (id.startsWith("\0") || normalized.startsWith("virtual:")) {
    return {
      id: normalized,
      classification: "core",
      capability: null,
      rationale: "virtual",
    };
  }
  const candidates = matchCandidates(normalized);
  const directoryOwner = moduleDirectoryOwner(normalized);
  const best =
    bestPrefixRule(rules, candidates, directoryOwner !== null) ??
    bestRegexRule(rules, candidates);
  if (best !== null) {
    return {
      id: normalized,
      classification: best.classification,
      capability: best.capability ?? null,
      rationale: best.rationale ?? "rule",
    };
  }
  return { id: normalized, ...fallbackClassification(normalized, directoryOwner) };
}

export function isUnclassified(entry) {
  return entry.rationale.startsWith("unclassified");
}

/**
 * Chunks reachable from every entry (HTML scripts + preloads, workers) by
 * following `imports` and, unless `staticOnly`, `dynamicImports`. Returns
 * `Map<entryLabel, { chunks: Set<file>, via: Map<file, parentFile|null> }>`.
 */
export function entryClosure(graph, { staticOnly = false } = {}) {
  const chunks = new Map(graph.chunks.map((c) => [c.file, c]));
  const result = new Map();
  const walk = (label, roots) => {
    const via = new Map();
    const queue = [];
    for (const root of roots) {
      if (!via.has(root)) {
        via.set(root, null);
        queue.push(root);
      }
    }
    while (queue.length > 0) {
      const file = queue.shift();
      const chunk = chunks.get(file);
      if (!chunk) continue;
      const next = staticOnly
        ? chunk.imports
        : [...chunk.imports, ...chunk.dynamicImports];
      for (const target of next) {
        if (!via.has(target)) {
          via.set(target, file);
          queue.push(target);
        }
      }
    }
    result.set(label, { chunks: new Set(via.keys()), via });
  };
  for (const entry of graph.entries)
    walk(entry.html, [...entry.scripts, ...entry.preloads]);
  for (const worker of graph.workers ?? []) {
    if (worker.file) walk(`worker:${worker.variant}`, [worker.file]);
  }
  return result;
}

export function pathTo(via, file) {
  const path = [];
  let cursor = file;
  while (cursor !== undefined && cursor !== null) {
    path.unshift(cursor);
    cursor = via.get(cursor);
  }
  return path;
}

/** Deterministic JSON: stable key order for objects, arrays kept as given. */
export function canonicalJson(value, indent = 2) {
  const space = indent > 0 ? indent : undefined;
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, space)}\n`;
}

/**
 * Module scripts and modulepreload links of an emitted HTML document,
 * resolved to dist-relative files. `base` is the build's public base
 * (`/OpenSesame/`); `htmlFile` is the document's own dist-relative path.
 */
export function parseHtmlEntry(html, { base, htmlFile }) {
  const scripts = [];
  const preloads = [];
  const resolveRef = (ref) => {
    const clean = ref.replace(/[?#].*$/, "");
    if (base && clean.startsWith(base)) return clean.slice(base.length);
    if (clean.startsWith("/")) return clean.slice(1);
    const dir = htmlFile.includes("/")
      ? htmlFile.slice(0, htmlFile.lastIndexOf("/"))
      : "";
    const parts = [...(dir ? dir.split("/") : []), ...clean.split("/")];
    const out = [];
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  };
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    const attrs = tag[0];
    if (!/\btype\s*=\s*["']module["']/i.test(attrs)) continue;
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (src && !/^[a-z]+:/i.test(src[1])) scripts.push(resolveRef(src[1]));
  }
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = tag[0];
    if (!/\brel\s*=\s*["']modulepreload["']/i.test(attrs)) continue;
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href && !/^[a-z]+:/i.test(href[1])) preloads.push(resolveRef(href[1]));
  }
  return {
    scripts: [...new Set(scripts)].sort(),
    preloads: [...new Set(preloads)].sort(),
  };
}
