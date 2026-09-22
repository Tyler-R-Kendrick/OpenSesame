/**
 * `capability-graph.json`, as the worker reads it (ownership.md §4.6, S07).
 *
 * The build emits one chunk record per output file: which source modules it
 * carries (each tagged with the capability that owns it, `null` for core),
 * its static and dynamic import edges, and the stylesheets it pulls in. The
 * worker needs exactly one question answered — "which files does this set of
 * approved module ids need offline?" — and this module answers it from data.
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
  /** Owning capability id, or null for a core module. */
  capability: string | null;
}>;

export type GraphChunk = Readonly<{
  file: string;
  isEntry: boolean;
  core: boolean;
  imports: readonly string[];
  css: readonly string[];
  modules: readonly GraphModule[];
}>;

export type CapabilityGraph = Readonly<{ chunks: readonly GraphChunk[] }>;

export type PlanAssetResolution =
  | Readonly<{ ok: true; files: readonly string[] }>
  | Readonly<{ ok: false; unknown: readonly string[] }>;

const DIST_PATH = /^[A-Za-z0-9][A-Za-z0-9._@-]*(\/[A-Za-z0-9._@-]+)*$/;

/** A dist-relative path: no scheme, no authority, no leading slash, no `..`. */
export function isDistPath(value: string): boolean {
  return (
    DIST_PATH.test(value) && !value.split("/").some((seg) => seg === "..")
  );
}

function pathList(value: BoundaryValue): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) if (isString(entry) && isDistPath(entry)) out.push(entry);
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
    });
  }
  return out;
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
      (modules.length > 0 && modules.every((m) => m.capability === null)),
    imports: pathList(record.imports),
    css: pathList(record.css),
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
  return { chunks };
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
 * their static import closure, every stylesheet those chunks import, and the
 * core entry chunks with their own closure. Dynamic imports are not followed
 * — they belong to whichever module owns them, and that module is either in
 * the plan (and therefore requested) or excluded (and therefore not saved).
 * Any id the graph does not know fails the whole request (PWA-09).
 */
export function resolvePlanAssets(
  graph: CapabilityGraph,
  moduleIds: readonly string[],
): PlanAssetResolution {
  const byFile = new Map<string, GraphChunk>();
  for (const chunk of graph.chunks) byFile.set(chunk.file, chunk);
  const roots: GraphChunk[] = graph.chunks.filter((c) => c.isEntry && c.core);
  const unknown: string[] = [];
  for (const id of moduleIds) {
    const owners = chunksForModule(graph, id);
    if (owners.length === 0) unknown.push(id);
    else roots.push(...owners);
  }
  if (unknown.length > 0) return { ok: false, unknown };
  const files = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const chunk = queue.pop();
    if (!chunk || files.has(chunk.file)) continue;
    files.add(chunk.file);
    for (const css of chunk.css) files.add(css);
    for (const dep of chunk.imports) {
      const next = byFile.get(dep);
      if (next) queue.push(next);
      else files.add(dep);
    }
  }
  return { ok: true, files: [...files].sort() };
}
