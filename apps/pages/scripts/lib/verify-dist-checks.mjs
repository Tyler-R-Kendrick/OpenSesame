/**
 * The disk-side half of the post-build verifier: read what is actually in a
 * built directory, compare it against the emitted `capability-graph.json`,
 * and measure it. Split out of `verify-capability-graph.mjs` so each stays
 * inside the 400-line budget (ADR 0093).
 *
 * Nothing here trusts the plugin's claim: the HTML documents are parsed, the
 * JS chunks are lexed, and every edge is rebuilt from the bytes on disk.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, posix, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { entryClosure, parseHtmlEntry } from "./capability-graph.mjs";

/** es-module-lexer ships inside Vite's pnpm store; resolve it from there. */
export async function loadLexer(repoRoot) {
  try {
    return await import("es-module-lexer");
  } catch {
    const store = join(repoRoot, "node_modules/.pnpm");
    const candidates = existsSync(store)
      ? readdirSync(store)
          .filter((name) => name.startsWith("es-module-lexer@"))
          .sort()
      : [];
    const pick = candidates.at(-1);
    if (!pick)
      throw new Error(
        "es-module-lexer is not installed anywhere under node_modules/.pnpm",
      );
    const require = createRequire(
      join(store, pick, "node_modules/es-module-lexer/package.json"),
    );
    return import(pathToFileURL(require.resolve("es-module-lexer")).href);
  }
}

export function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

/** Static and dynamic (literal) imports of one chunk, dist-relative. */
export function chunkImports(parse, code, file) {
  const [imports] = parse(code);
  const out = { static: new Set(), dynamic: new Set(), external: new Set() };
  const dir = posix.dirname(file);
  for (const entry of imports) {
    if (entry.d === -2) continue; // import.meta
    let specifier = entry.n;
    if (specifier === undefined && entry.d >= 0) {
      const raw = code.slice(entry.s, entry.e).trim();
      const literal = raw.match(/^["'`]([^"'`]+)["'`]$/);
      specifier = literal ? literal[1] : undefined;
    }
    if (!specifier) continue;
    if (
      /^[a-z]+:/i.test(specifier) ||
      !(specifier.startsWith(".") || specifier.startsWith("/"))
    ) {
      out.external.add(specifier);
      continue;
    }
    const resolved = specifier.startsWith("/")
      ? specifier.slice(1)
      : posix.normalize(posix.join(dir, specifier));
    (entry.d === -1 ? out.static : out.dynamic).add(resolved);
  }
  return out;
}

/** HTML entries and JS edges read from disk, without consulting the graph. */
export function readDiskView(dist, files, graph, base, parse) {
  const entries = [];
  const chunks = new Map();
  const externals = new Map();
  for (const file of files) {
    const ext = extname(file);
    if (ext === ".html") {
      entries.push({
        html: file,
        capability:
          graph.entries.find((e) => e.html === file)?.capability ?? null,
        ...parseHtmlEntry(readFileSync(join(dist, file), "utf8"), {
          base,
          htmlFile: file,
        }),
      });
    } else if (ext === ".js" || ext === ".mjs") {
      const edges = chunkImports(
        parse,
        readFileSync(join(dist, file), "utf8"),
        file,
      );
      chunks.set(file, edges);
      if (edges.external.size > 0)
        externals.set(file, [...edges.external].sort());
    }
  }
  return { entries, chunks, externals };
}

function compareEntries(graph, disk, onDisk, note) {
  for (const entry of graph.entries) {
    if (!onDisk.has(entry.html))
      note("MISSING_HTML", `${entry.html} listed in graph but absent on disk`);
    for (const ref of [...entry.scripts, ...entry.preloads]) {
      if (!onDisk.has(ref))
        note(
          "MISSING_ENTRY_SCRIPT",
          `${entry.html} references ${ref}, absent on disk`,
        );
    }
    const found = disk.entries.find((e) => e.html === entry.html);
    if (
      found &&
      (JSON.stringify(found.scripts) !== JSON.stringify(entry.scripts) ||
        JSON.stringify(found.preloads) !== JSON.stringify(entry.preloads))
    ) {
      note(
        "ENTRY_MISMATCH",
        `${entry.html}: graph ${JSON.stringify([entry.scripts, entry.preloads])} vs disk ${JSON.stringify([found.scripts, found.preloads])}`,
      );
    }
  }
  for (const found of disk.entries) {
    if (!graph.entries.some((e) => e.html === found.html))
      note("UNACCOUNTED_HTML", `${found.html} on disk but not in graph`);
  }
}

const sameSet = (a, b) =>
  JSON.stringify([...new Set(a)].sort()) ===
  JSON.stringify([...new Set(b)].sort());

function compareChunk(chunk, edges, onDisk, note) {
  if (!sameSet(chunk.imports, edges.static))
    note(
      "STATIC_EDGE_MISMATCH",
      `${chunk.file}: graph ${JSON.stringify(chunk.imports)} vs disk ${JSON.stringify([...edges.static].sort())}`,
    );
  if (!sameSet(chunk.dynamicImports, edges.dynamic))
    note(
      "DYNAMIC_EDGE_MISMATCH",
      `${chunk.file}: graph ${JSON.stringify(chunk.dynamicImports)} vs disk ${JSON.stringify([...edges.dynamic].sort())}`,
    );
  for (const ref of [
    ...chunk.imports,
    ...chunk.dynamicImports,
    ...chunk.importedCss,
    ...chunk.importedAssets,
  ]) {
    if (!onDisk.has(ref))
      note("MISSING_REFERENCE", `${chunk.file} references ${ref}, absent on disk`);
  }
}

/** Every graph record exists on disk, and every JS file on disk is accounted for. */
export function compareGraphToDisk(graph, disk, onDisk, note) {
  compareEntries(graph, disk, onDisk, note);
  for (const chunk of graph.chunks) {
    if (!onDisk.has(chunk.file)) {
      note("MISSING_CHUNK", `${chunk.file} listed in graph but absent on disk`);
      continue;
    }
    compareChunk(chunk, disk.chunks.get(chunk.file), onDisk, note);
  }
  // A JS file is accounted for as a chunk, a worker variant, a public file,
  // or a bundled asset (a dedicated web worker Vite emits as an asset).
  const knownJs = [
    ...graph.chunks.map((c) => c.file),
    ...graph.workers.map((w) => w.file),
    ...graph.publicFiles.map((p) => p.file.replace(/\/\*\*$/, "")),
    ...(graph.assets ?? []).map((a) => a.file),
  ];
  for (const file of disk.chunks.keys()) {
    if (!knownJs.some((k) => file === k || file.startsWith(`${k}/`)))
      note(
        "UNACCOUNTED_CHUNK",
        `${file} on disk but in no graph chunk, worker or public file`,
      );
  }
  for (const [file, list] of disk.externals)
    note("EXTERNAL_IMPORT", `${file} imports outside dist: ${list.join(", ")}`);
}

/** The graph re-stated with the edges and presence flags read from disk. */
export function diskGraphOf(graph, disk, onDisk) {
  return {
    ...graph,
    entries: disk.entries,
    chunks: graph.chunks.map((chunk) => {
      const edges = disk.chunks.get(chunk.file);
      return edges
        ? {
            ...chunk,
            imports: [...edges.static].sort(),
            dynamicImports: [...edges.dynamic].sort(),
          }
        : chunk;
    }),
    workers: graph.workers.map((w) => ({ ...w, present: onDisk.has(w.file) })),
    publicFiles: graph.publicFiles.map((p) => ({
      ...p,
      present: [...onDisk].some(
        (f) => f === p.file || f.startsWith(`${p.file.replace(/\/\*\*$/, "")}/`),
      ),
    })),
  };
}

/** BUILD-04: an excluded capability is physically absent, not merely unused. */
export function expectAbsentChecks(moduleIds, graph, distribution, files) {
  return moduleIds.map((moduleId) => {
    const capability = moduleId.includes("/")
      ? moduleId.slice(0, moduleId.indexOf("/"))
      : moduleId;
    const chunks = graph.chunks
      .filter((c) =>
        c.modules.some(
          (m) =>
            m.id.startsWith(`apps/pages/src/modules/${capability}/`) ||
            m.capability === capability,
        ),
      )
      .map((c) => c.file);
    const chunkFiles = files.filter(
      (f) =>
        f.startsWith(`assets/cap-${capability}-`) ||
        f === `assets/cap-${capability}.js`,
    );
    const inTable = distribution.moduleIds.includes(moduleId);
    return {
      module: moduleId,
      capability,
      absent: chunks.length === 0 && chunkFiles.length === 0 && !inTable,
      chunks,
      files: chunkFiles,
      inTable,
    };
  });
}

/** The capability a chunk file belongs to, by the plugin's `cap-<id>` name. */
function capabilityOfChunk(file, graphChunks) {
  // The plugin names an optional capability's chunk `cap-<capability>`; prefer
  // that recorded name over guessing where the hash starts, since a capability
  // id may itself contain dashes.
  const named = graphChunks.get(file)?.name;
  if (named?.startsWith("cap-")) return named.slice(4);
  return file.match(/^assets\/cap-(.+)-[A-Za-z0-9_-]{8}\.js$/)?.[1] ?? null;
}

/** Total, JS (raw + gzip), CSS, largest, per-capability and bootstrap sizes. */
export function measureSizes(dist, files, graph, diskGraph, onDisk) {
  const graphChunks = new Map(graph.chunks.map((c) => [c.file, c]));
  const sizes = {
    total: 0,
    javascript: 0,
    javascriptGzip: 0,
    css: 0,
    largestAsset: 0,
    largestAssetName: "",
    fileCount: files.length,
    entryStatic: 0,
    entryStaticGzip: 0,
    capabilityChunks: {},
  };
  for (const file of files) {
    const bytes = readFileSync(join(dist, file));
    sizes.total += bytes.byteLength;
    if (bytes.byteLength > sizes.largestAsset)
      Object.assign(sizes, {
        largestAsset: bytes.byteLength,
        largestAssetName: file,
      });
    const ext = extname(file);
    if (ext === ".css") {
      sizes.css += bytes.byteLength;
      continue;
    }
    if (ext !== ".js" && ext !== ".mjs") continue;
    sizes.javascript += bytes.byteLength;
    sizes.javascriptGzip += gzipSync(bytes, { level: 9 }).byteLength;
    const capability = capabilityOfChunk(file, graphChunks);
    if (capability)
      sizes.capabilityChunks[capability] =
        (sizes.capabilityChunks[capability] ?? 0) + bytes.byteLength;
  }
  // The bootstrap cut: what a core HTML entry pulls in before any dynamic
  // import, which is the number ADR 0093's budgets and the evidence track.
  const coreEntries = {
    ...diskGraph,
    entries: diskGraph.entries.filter((e) => e.capability === null),
    workers: [],
  };
  for (const [, { chunks }] of entryClosure(coreEntries, { staticOnly: true })) {
    for (const file of chunks) {
      if (!onDisk.has(file)) continue;
      const bytes = readFileSync(join(dist, file));
      sizes.entryStatic += bytes.byteLength;
      sizes.entryStaticGzip += gzipSync(bytes, { level: 9 }).byteLength;
    }
  }
  return sizes;
}

export const distRelative = (dist, file) => relative(dist, file);
