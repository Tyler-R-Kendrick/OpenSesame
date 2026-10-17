/**
 * `capability-graph.json`, as the worker reads it (ownership.md §4.6, S07).
 *
 * The build emits one chunk record per output file (`scripts/lib/
 * capability-graph.mjs`): `file`, `isEntry`, `imports`, `dynamicImports`,
 * `importedCss`, and `modules[]`, each module tagged `classification`
 * (`core` | `shared` | `optional`) and `capability` (the owning capability id).
 * Classification governs availability independently of that owner: a core
 * module may name its capability without becoming optional. The worker needs
 * exactly one question
 * answered — "which files does this set of approved module ids need
 * offline?" — and this module answers it from that data. A module id maps to
 * the chunks whose modules the id's capability owns; a record that also
 * carries a `moduleId` is matched on it first.
 *
 * Everything here is parsed from a boundary value with an allowlist: a file
 * is a relative dist path (no scheme, no leading slash, no `..`), never a
 * URL, so a hostile graph cannot point the worker off-origin.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

export type GraphModule = Readonly<{
  /** `connectors.external/runtime` when the build knows it; else null. */
  moduleId: string | null;
  /** Owning capability id; core/shared modules may also name their owner. */
  capability: string | null;
  classification: "core" | "shared" | "optional" | null;
}>;

export type GraphChunk = Readonly<{
  file: string;
  isEntry: boolean;
  core: boolean;
  /** Individually installed resources stay outside a capability's cache plan. */
  onDemand: boolean;
  imports: readonly string[];
  dynamicImports: readonly string[];
  css: readonly string[];
  assets: readonly string[];
  modules: readonly GraphModule[];
}>;

export type CapabilityGraph = Readonly<{
  chunks: readonly GraphChunk[];
  shellAssets: readonly string[];
}>;

export type PlanAssetResolution =
  | Readonly<{ ok: true; files: readonly string[] }>
  | Readonly<{ ok: false; unknown: readonly string[] }>;

const DIST_PATH = /^[A-Za-z0-9][A-Za-z0-9._@-]*(\/[A-Za-z0-9._@-]+)*$/;

/** A dist-relative path: no scheme, no authority, no leading slash, no `..`. */
export function isDistPath(value: string): boolean {
  return DIST_PATH.test(value) && !value.split("/").some((seg) => seg === "..");
}

function pathList(value: BoundaryValue): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value)
    if (isString(entry) && isDistPath(entry)) out.push(entry);
  return out;
}

function moduleList(value: BoundaryValue): GraphModule[] {
  if (!Array.isArray(value)) return [];
  const out: GraphModule[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) continue;
    out.push({
      moduleId: isString(entry.moduleId) ? entry.moduleId : null,
      capability: isString(entry.capability) ? entry.capability : null,
      classification:
        entry.classification === "core" ||
        entry.classification === "shared" ||
        entry.classification === "optional"
          ? entry.classification
          : null,
    });
  }
  return out;
}

/** A core/shared module may still name its owner; ownership is not optionality. */
function alwaysAvailable(module: GraphModule): boolean {
  return (
    module.classification === "core" ||
    module.classification === "shared" ||
    module.capability === null
  );
}

function chunkOf(record: JsonObject): GraphChunk | null {
  if (!isString(record.file) || !isDistPath(record.file)) return null;
  const modules = moduleList(record.modules);
  const ownership = isString(record.ownership) ? record.ownership : null;
  return {
    file: record.file,
    isEntry: record.isEntry === true,
    core:
      record.core === true ||
      ownership === "core" ||
      (modules.length > 0 && modules.every(alwaysAvailable)),
    onDemand: record.onDemand === true,
    imports: pathList(record.imports),
    dynamicImports: pathList(record.dynamicImports),
    css: [...pathList(record.importedCss), ...pathList(record.css)],
    assets: pathList(record.importedAssets),
    modules,
  };
}

/** Parse the emitted graph; `null` when it is not a graph at all. */
export function parseCapabilityGraph(
  value: BoundaryValue,
): CapabilityGraph | null {
  if (!isJsonObject(value) || !Array.isArray(value.chunks)) return null;
  const chunks: GraphChunk[] = [];
  for (const entry of value.chunks) {
    if (!isJsonObject(entry)) continue;
    const chunk = chunkOf(entry);
    if (chunk) chunks.push(chunk);
  }
  return { chunks, shellAssets: shellAssets(value.entries) };
}

/** Only the core shell's resource links, never another entry's public assets. */
function shellAssets(value: BoundaryValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isJsonObject(entry) &&
    entry.html === "index.html" &&
    entry.capability === null
      ? pathList(entry.assets)
      : [],
  );
}

function capabilityOf(moduleId: string): string {
  return moduleId.slice(0, moduleId.indexOf("/"));
}

function chunksForModule(
  graph: CapabilityGraph,
  moduleId: string,
): GraphChunk[] {
  const byId = graph.chunks.filter((c) =>
    c.modules.some((m) => m.moduleId === moduleId),
  );
  if (byId.length > 0) return byId;
  const capability = capabilityOf(moduleId);
  return graph.chunks.filter((c) =>
    c.modules.some((m) => m.capability === capability),
  );
}

/**
 * Files an approved plan needs: the chunks carrying the requested modules,
 * their import closure, stylesheets and assets, and the core entry chunks.
 * Lazy imports are included only when every owner is shared or approved;
 * excluded capabilities and individually installed resources stay outside
 * the plan. Static dependencies remain necessary to load their owner.
 * Any id the graph does not know fails the whole request (PWA-09).
 */
export function resolvePlanAssets(
  graph: CapabilityGraph,
  moduleIds: readonly string[],
): PlanAssetResolution {
  const byFile = new Map<string, GraphChunk>();
  for (const chunk of graph.chunks) byFile.set(chunk.file, chunk);
  const roots: GraphChunk[] = graph.chunks.filter((c) => c.isEntry && c.core);
  const approved = new Set(moduleIds.map(capabilityOf));
  const unknown: string[] = [];
  for (const id of moduleIds) {
    const owners = chunksForModule(graph, id);
    if (owners.length === 0) unknown.push(id);
    else roots.push(...owners.filter((owner) => !owner.onDemand));
  }
  if (unknown.length > 0) return { ok: false, unknown };
  const files = new Set(graph.shellAssets);
  const queue = [...roots];
  while (queue.length > 0) {
    const chunk = queue.pop();
    if (!chunk || files.has(chunk.file)) continue;
    files.add(chunk.file);
    for (const css of chunk.css) files.add(css);
    for (const asset of chunk.assets) files.add(asset);
    for (const dep of chunk.imports) {
      const next = byFile.get(dep);
      if (next) queue.push(next);
      else files.add(dep);
    }
    for (const dep of chunk.dynamicImports) {
      const next = byFile.get(dep);
      if (next && approvedLazyChunk(next, approved)) queue.push(next);
    }
  }
  return { ok: true, files: [...files].sort() };
}

function approvedLazyChunk(
  chunk: GraphChunk,
  approved: ReadonlySet<string>,
): boolean {
  if (chunk.onDemand) return false;
  return (
    chunk.core ||
    (chunk.modules.length > 0 &&
      chunk.modules.every(
        (module) =>
          alwaysAvailable(module) ||
          (module.capability !== null && approved.has(module.capability)),
      ))
  );
}
