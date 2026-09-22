/**
 * The forbidden-reachability rules of ownership.md §4.6, split out of
 * `capability-graph.mjs` so each rule family stays one readable function and
 * the module stays inside the 400-line budget (ADR 0093).
 *
 * Pure over the plain graph shape documented in `capability-graph.mjs`: the
 * plugin runs these over Rollup's bundle and the verifier runs the same rules
 * again over what is actually on disk.
 */
import {
  MODULES_DIR,
  entryClosure,
  moduleDirectoryOwner,
  pathTo,
} from "./capability-graph.mjs";

const optionalIn = (chunk) =>
  chunk.modules.filter((m) => m.classification === "optional" && m.capability);

function entryOwner(graph, label) {
  if (label.startsWith("worker:")) {
    const worker = (graph.workers ?? []).find(
      (w) => `worker:${w.variant}` === label,
    );
    return worker?.capability ?? null;
  }
  return graph.entries.find((e) => e.html === label)?.capability ?? null;
}

/** One chunk may not mix two optional capabilities (BUILD-05). */
function mixedChunkViolation(chunk, add) {
  const capabilities = new Set(optionalIn(chunk).map((m) => m.capability));
  if (capabilities.size <= 1) return;
  const list = [...capabilities].sort().join(", ");
  add("error", "MIXED_CAPABILITY_CHUNK", {
    chunk: chunk.file,
    capability: list,
    message: `chunk mixes optional capabilities ${list}`,
  });
}

/** A file under `src/modules/<cap>/` is owned by that directory (BUILD-06). */
function misclassifiedModuleViolation(chunk, module, core, add) {
  const owner = moduleDirectoryOwner(module.id);
  if (owner === null) return;
  const expected = core.has(owner) ? "core" : "optional";
  if (module.capability === owner && module.classification === expected) return;
  add("error", "MISCLASSIFIED_MODULE_PATH", {
    module: module.id,
    capability: module.capability,
    chunk: chunk.file,
    message: `module under ${MODULES_DIR}${owner}/ classified ${module.classification}/${module.capability ?? "-"} (${module.rationale}); expected ${expected}/${owner}`,
  });
}

/** Per-chunk and per-module rules that need no closure. */
function chunkViolations(graph, distributed, mode, core, add) {
  for (const chunk of graph.chunks) {
    mixedChunkViolation(chunk, add);
    for (const module of chunk.modules) {
      misclassifiedModuleViolation(chunk, module, core, add);
      if (
        mode === "hardened" &&
        module.classification === "optional" &&
        module.capability &&
        !distributed.has(module.capability)
      ) {
        add("error", "EXCLUDED_MODULE_EMITTED", {
          module: module.id,
          capability: module.capability,
          chunk: chunk.file,
          message: `excluded capability "${module.capability}" was emitted in ${chunk.file}`,
        });
      }
    }
  }
}

/**
 * Walk one closure and report every optional module it reaches for which
 * `report` returns a violation code.
 */
function reachViolations(graph, chunkByFile, closure, report, add) {
  for (const [label, { chunks, via }] of closure) {
    const owner = entryOwner(graph, label);
    for (const file of chunks) {
      const chunk = chunkByFile.get(file);
      if (!chunk) continue;
      for (const module of optionalIn(chunk)) {
        const found = report(module, owner);
        if (!found) continue;
        add("error", found.code, {
          module: module.id,
          capability: module.capability,
          chunk: file,
          entry: label,
          path: pathTo(via, file),
          message: found.message(label, module),
        });
      }
    }
  }
}

/** Hardened builds also refuse excluded HTML entries, public files, workers. */
function hardenedArtifactViolations(graph, distributed, core, add) {
  const excluded = (capability) =>
    Boolean(capability) &&
    !distributed.has(capability) &&
    !core.has(capability);
  for (const entry of graph.entries) {
    if (!excluded(entry.capability)) continue;
    add("error", "EXCLUDED_HTML_ENTRY", {
      chunk: entry.html,
      capability: entry.capability,
      message: `HTML entry ${entry.html} belongs to excluded "${entry.capability}"`,
    });
  }
  for (const file of graph.publicFiles ?? []) {
    if (file.present === false || !excluded(file.capability)) continue;
    add("error", "EXCLUDED_PUBLIC_FILE", {
      chunk: file.file,
      capability: file.capability,
      message: `public file ${file.file} belongs to excluded "${file.capability}"`,
    });
  }
  for (const worker of graph.workers ?? []) {
    if (worker.present === false) continue;
    if (!worker.capability || distributed.has(worker.capability)) continue;
    add("error", "EXCLUDED_WORKER", {
      chunk: worker.file,
      capability: worker.capability,
      message: `worker variant ${worker.variant} belongs to excluded "${worker.capability}"`,
    });
  }
}

/**
 * The forbidden-reachability rules. Returns `{ severity, code, module,
 * capability, chunk, entry, path, message }` records; `severity: "error"`
 * fails a build, `"warning"` is diagnostic (a dynamic edge from core code to
 * an optional module that bypasses the MODULE_TABLE).
 *
 * @param graph the graph shape documented in `capability-graph.mjs`
 * @param distributed Set<CapabilityId> present in this build
 * @param mode "selective" | "hardened"
 * @param options.coreCapabilities Set<CapabilityId> with tier core (so a
 *   module directory owned by a core capability may be classified core)
 */
export function violations(graph, distributed, mode, options = {}) {
  const core = options.coreCapabilities ?? new Set();
  const out = [];
  const add = (severity, code, fields) =>
    out.push({ severity, code, ...fields });
  const chunkByFile = new Map(graph.chunks.map((c) => [c.file, c]));

  chunkViolations(graph, distributed, mode, core, add);

  reachViolations(
    graph,
    chunkByFile,
    entryClosure(graph, { staticOnly: true }),
    (module, owner) =>
      module.capability === owner
        ? null
        : {
            code: "ENTRY_STATIC_OPTIONAL",
            message: (label) =>
              `${label} reaches optional "${module.capability}" through static imports`,
          },
    add,
  );

  if (mode === "hardened") {
    reachViolations(
      graph,
      chunkByFile,
      entryClosure(graph),
      (module) =>
        distributed.has(module.capability)
          ? null
          : {
              code: "EXCLUDED_REACHABLE",
              message: (label) =>
                `${label} can reach excluded "${module.capability}"`,
            },
      add,
    );
    hardenedArtifactViolations(graph, distributed, core, add);
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
    const key = (v) =>
      `${v.severity}|${v.code}|${v.entry ?? ""}|${v.chunk ?? ""}|${v.module ?? ""}`;
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
  const header = [
    "severity",
    "code",
    "module",
    "capability",
    "chunk",
    "reachable from",
  ];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
  );
  const line = (cells) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  const errors = list.filter((v) => v.severity === "error").length;
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    "",
    `${errors} error(s), ${list.length - errors} warning(s)`,
  ].join("\n");
}
