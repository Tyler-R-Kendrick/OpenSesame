/**
 * Shared helpers for the capability build plugin and the post-build verifier:
 * module classification, entry closures over the emitted chunk graph, and the
 * forbidden-reachability rules (ownership.md §4.6). Pure over plain data so
 * the same rules run inside Vite and again from disk.
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
  let path = toPosix(id).replace(/[?#].*$/, "");
  const nodeModules = path.lastIndexOf("/node_modules/");
  if (nodeModules >= 0) return `node_modules/${path.slice(nodeModules + "/node_modules/".length)}`;
  const root = toPosix(repoRoot).replace(/\/$/, "");
  if (path.startsWith(`${root}/`)) path = path.slice(root.length + 1);
  return path;
}

/** Candidate strings a prefix rule may match: repo-relative and app-relative. */
function matchCandidates(normalized) {
  const candidates = [normalized];
  if (normalized.startsWith("apps/pages/")) candidates.push(normalized.slice("apps/pages/".length));
  return candidates;
}

/**
 * Classify one module by the longest matching prefix rule. Rules are
 * `{ pattern: string | RegExp, classification, capability, rationale }`; a
 * RegExp rule is consulted only when no prefix rule matches.
 */
export function classifyModule(id, rules, { repoRoot }) {
  const normalized = normalizeModuleId(id, { repoRoot });
  if (id.startsWith("\0") || normalized.startsWith("virtual:")) {
    return { id: normalized, classification: "core", capability: null, rationale: "virtual" };
  }
  const candidates = matchCandidates(normalized);
  let best = null;
  for (const rule of rules ?? []) {
    if (typeof rule.pattern !== "string") continue;
    const pattern = toPosix(rule.pattern);
    if (candidates.some((c) => c.startsWith(pattern))) {
      if (best === null || pattern.length > best.pattern.length) best = { ...rule, pattern };
    }
  }
  if (best === null) {
    for (const rule of rules ?? []) {
      if (rule.pattern instanceof RegExp && candidates.some((c) => rule.pattern.test(c))) {
        best = rule;
        break;
      }
    }
  }
  if (best !== null) {
    return {
      id: normalized,
      classification: best.classification,
      capability: best.capability ?? null,
      rationale: best.rationale ?? "rule",
    };
  }
  if (normalized.startsWith("node_modules/")) {
    return { id: normalized, classification: "shared", capability: null, rationale: "unclassified dependency" };
  }
  if (normalized.startsWith(MODULES_DIR)) {
    const capability = normalized.slice(MODULES_DIR.length).split("/")[0];
    return { id: normalized, classification: "optional", capability, rationale: "module directory" };
  }
  if (normalized.startsWith("apps/pages/")) {
    return { id: normalized, classification: "core", capability: null, rationale: "unclassified source" };
  }
  return { id: normalized, classification: "shared", capability: null, rationale: "unclassified workspace package" };
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
      const next = staticOnly ? chunk.imports : [...chunk.imports, ...chunk.dynamicImports];
      for (const target of next) {
        if (!via.has(target)) {
          via.set(target, file);
          queue.push(target);
        }
      }
    }
    result.set(label, { chunks: new Set(via.keys()), via });
  };
  for (const entry of graph.entries) walk(entry.html, [...entry.scripts, ...entry.preloads]);
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

function entryOwner(graph, label) {
  if (label.startsWith("worker:")) {
    const worker = (graph.workers ?? []).find((w) => `worker:${w.variant}` === label);
    return worker?.capability ?? null;
  }
  return graph.entries.find((e) => e.html === label)?.capability ?? null;
}

/**
 * The forbidden-reachability rules. Returns `{ severity, code, module,
 * capability, chunk, entry, path, message }` records; `severity: "error"`
 * fails a build, `"warning"` is diagnostic (a dynamic edge from core code to
 * an optional module that bypasses the MODULE_TABLE).
 *
 * @param graph the graph above
 * @param distributed Set<CapabilityId> present in this build
 * @param mode "selective" | "hardened"
 * @param options.coreCapabilities Set<CapabilityId> with tier core (so a
 *   module directory owned by a core capability may be classified core)
 */
export function violations(graph, distributed, mode, options = {}) {
  const core = options.coreCapabilities ?? new Set();
  const out = [];
  const add = (severity, code, fields) => out.push({ severity, code, ...fields });
  const optionalIn = (chunk) =>
    chunk.modules.filter((m) => m.classification === "optional" && m.capability);
  const chunkByFile = new Map(graph.chunks.map((c) => [c.file, c]));

  for (const chunk of graph.chunks) {
    const capabilities = new Set(optionalIn(chunk).map((m) => m.capability));
    if (capabilities.size > 1) {
      add("error", "MIXED_CAPABILITY_CHUNK", {
        chunk: chunk.file,
        capability: [...capabilities].sort().join(", "),
        message: `chunk mixes optional capabilities ${[...capabilities].sort().join(", ")}`,
      });
    }
    for (const module of chunk.modules) {
      if (module.id.startsWith(MODULES_DIR)) {
        const owner = module.id.slice(MODULES_DIR.length).split("/")[0];
        const expected = core.has(owner) ? "core" : "optional";
        if (module.capability !== owner || module.classification !== expected) {
          add("error", "MISCLASSIFIED_MODULE_PATH", {
            module: module.id,
            capability: module.capability,
            chunk: chunk.file,
            message: `module under ${MODULES_DIR}${owner}/ classified ${module.classification}/${module.capability ?? "-"} (${module.rationale}); expected ${expected}/${owner}`,
          });
        }
      }
      if (mode === "hardened" && module.classification === "optional" && module.capability && !distributed.has(module.capability)) {
        add("error", "EXCLUDED_MODULE_EMITTED", {
          module: module.id,
          capability: module.capability,
          chunk: chunk.file,
          message: `excluded capability "${module.capability}" was emitted in ${chunk.file}`,
        });
      }
    }
  }

  const staticClosure = entryClosure(graph, { staticOnly: true });
  for (const [label, { chunks, via }] of staticClosure) {
    const owner = entryOwner(graph, label);
    for (const file of chunks) {
      const chunk = chunkByFile.get(file);
      if (!chunk) continue;
      for (const module of optionalIn(chunk)) {
        if (module.capability === owner) continue;
        add("error", "ENTRY_STATIC_OPTIONAL", {
          module: module.id,
          capability: module.capability,
          chunk: file,
          entry: label,
          path: pathTo(via, file),
          message: `${label} reaches optional "${module.capability}" through static imports`,
        });
      }
    }
  }

  if (mode === "hardened") {
    const fullClosure = entryClosure(graph);
    for (const [label, { chunks, via }] of fullClosure) {
      for (const file of chunks) {
        const chunk = chunkByFile.get(file);
        if (!chunk) continue;
        for (const module of optionalIn(chunk)) {
          if (distributed.has(module.capability)) continue;
          add("error", "EXCLUDED_REACHABLE", {
            module: module.id,
            capability: module.capability,
            chunk: file,
            entry: label,
            path: pathTo(via, file),
            message: `${label} can reach excluded "${module.capability}"`,
          });
        }
      }
    }
    for (const entry of graph.entries) {
      if (entry.capability && !distributed.has(entry.capability) && !core.has(entry.capability)) {
        add("error", "EXCLUDED_HTML_ENTRY", {
          chunk: entry.html,
          capability: entry.capability,
          message: `HTML entry ${entry.html} belongs to excluded "${entry.capability}"`,
        });
      }
    }
    for (const file of graph.publicFiles ?? []) {
      if (file.present === false) continue;
      if (file.capability && !distributed.has(file.capability) && !core.has(file.capability)) {
        add("error", "EXCLUDED_PUBLIC_FILE", {
          chunk: file.file,
          capability: file.capability,
          message: `public file ${file.file} belongs to excluded "${file.capability}"`,
        });
      }
    }
    for (const worker of graph.workers ?? []) {
      if (worker.present === false) continue;
      if (worker.capability && !distributed.has(worker.capability)) {
        add("error", "EXCLUDED_WORKER", {
          chunk: worker.file,
          capability: worker.capability,
          message: `worker variant ${worker.variant} belongs to excluded "${worker.capability}"`,
        });
      }
    }
  }

  for (const edge of graph.moduleEdges ?? []) {
    if (edge.kind !== "dynamic" || edge.viaTable) continue;
    add("warning", "CORE_DYNAMIC_OPTIONAL", {
      module: edge.from,
      capability: edge.toCapability ?? null,
      chunk: edge.to,
      message: `${edge.from} imports optional ${edge.to} dynamically outside MODULE_TABLE`,
    });
  }

  return out.sort((a, b) => {
    const key = (v) => `${v.severity}|${v.code}|${v.entry ?? ""}|${v.chunk ?? ""}|${v.module ?? ""}`;
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  });
}

/** A fixed-width table: module → capability → chunk → reachable-from entry. */
export function formatViolations(list) {
  if (list.length === 0) return "capability graph: CLEAN";
  const rows = list.map((v) => [
    v.severity,
    v.code,
    v.module ?? "-",
    v.capability ?? "-",
    v.chunk ?? "-",
    v.entry ?? "-",
  ]);
  const header = ["severity", "code", "module", "capability", "chunk", "reachable from"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  const errors = list.filter((v) => v.severity === "error").length;
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    "",
    `${errors} error(s), ${list.length - errors} warning(s)`,
  ].join("\n");
}

/** Deterministic JSON: stable key order for objects, arrays kept as given. */
export function canonicalJson(value, indent = 2) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, indent)}\n`;
}
