#!/usr/bin/env node
/**
 * Post-build verifier for capability composition (ownership.md §4.6).
 *
 *   node scripts/verify-capability-graph.mjs --dist dist [--profile <path>]
 *        [--mode selective|hardened] [--base /OpenSesame/]
 *        [--expect-absent <module-id>]... [--out measurements.json] [--quiet]
 *
 * Independent of the plugin's own claim: it enumerates every file in `dist/`,
 * parses each HTML document for module scripts and modulepreloads, lexes every
 * JS chunk for its import specifiers (es-module-lexer), rebuilds the closure
 * from disk and re-runs the same invariants the plugin enforced — then checks
 * that `capability-graph.json` agrees with disk (every referenced file exists,
 * every JS chunk on disk is accounted for, every edge matches). Reports sizes
 * (total, js, js gzip, css, largest, bootstrap static closure, per-capability
 * chunks) as JSON for the evidence sheets; exits 1 on any violation.
 *
 * `--expect-absent <module-id>` asserts an excluded capability's module is in
 * no chunk and that no `cap-<capability>-*.js` chunk exists (BUILD-04).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  canonicalJson,
  entryClosure,
  formatViolations,
  parseHtmlEntry,
  violations,
} from "./lib/capability-graph.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(APP_ROOT, "../..");

/** es-module-lexer ships inside Vite's pnpm store; resolve it from there. */
async function loadLexer() {
  try {
    return await import("es-module-lexer");
  } catch {
    const store = join(REPO_ROOT, "node_modules/.pnpm");
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

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function parseArgs(argv) {
  const args = {
    dist: "dist",
    profile: null,
    mode: null,
    base: null,
    expectAbsent: [],
    out: null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--dist") args.dist = next();
    else if (flag === "--profile") args.profile = next();
    else if (flag === "--mode") args.mode = next();
    else if (flag === "--base") args.base = next();
    else if (flag === "--expect-absent") args.expectAbsent.push(next());
    else if (flag === "--out") args.out = next();
    else if (flag === "--quiet") args.quiet = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Static and dynamic (literal) imports of one chunk, dist-relative. */
function chunkImports(parse, code, file) {
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

export async function verifyDist(options) {
  const dist = resolve(APP_ROOT, options.dist);
  if (!existsSync(dist)) throw new Error(`dist directory not found: ${dist}`);
  const graphPath = join(dist, "capability-graph.json");
  const distributionPath = join(dist, "capability-distribution.json");
  for (const path of [graphPath, distributionPath]) {
    if (!existsSync(path))
      throw new Error(`missing ${relative(dist, path)} in ${dist}`);
  }
  const graph = readJson(graphPath);
  const distribution = readJson(distributionPath);
  const base = options.base ?? distribution.basePath ?? "/";
  const mode = options.mode ?? graph.mode;
  const mismatches = [];
  const note = (code, message) =>
    mismatches.push({ severity: "error", code, message });
  if (graph.mode !== mode)
    note("MODE_MISMATCH", `graph says ${graph.mode}, expected ${mode}`);
  if (graph.distributionId !== distribution.distributionId)
    note("DISTRIBUTION_ID_MISMATCH", "graph and contract disagree");
  if (options.profile) {
    const expected =
      JSON.parse(readFileSync(resolve(APP_ROOT, options.profile), "utf8"))
        .name ?? posix.basename(options.profile, ".json");
    if (graph.profile !== expected)
      note(
        "PROFILE_MISMATCH",
        `graph built from ${graph.profile}, expected ${expected}`,
      );
  }

  const { init, parse } = await loadLexer();
  await init;
  const files = walk(dist).map((f) => relative(dist, f).split("\\").join("/"));
  const onDisk = new Set(files);
  const graphChunks = new Map(graph.chunks.map((c) => [c.file, c]));

  // Disk view: HTML entries and JS edges, built without consulting the graph.
  const diskEntries = [];
  const diskChunks = new Map();
  const externals = new Map();
  for (const file of files) {
    const ext = extname(file);
    if (ext === ".html") {
      const owner =
        graph.entries.find((e) => e.html === file)?.capability ?? null;
      diskEntries.push({
        html: file,
        capability: owner,
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
      diskChunks.set(file, edges);
      if (edges.external.size > 0)
        externals.set(file, [...edges.external].sort());
    }
  }

  // Graph ↔ disk agreement.
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
    const disk = diskEntries.find((e) => e.html === entry.html);
    if (
      disk &&
      (JSON.stringify(disk.scripts) !== JSON.stringify(entry.scripts) ||
        JSON.stringify(disk.preloads) !== JSON.stringify(entry.preloads))
    ) {
      note(
        "ENTRY_MISMATCH",
        `${entry.html}: graph ${JSON.stringify([entry.scripts, entry.preloads])} vs disk ${JSON.stringify([disk.scripts, disk.preloads])}`,
      );
    }
  }
  for (const disk of diskEntries) {
    if (!graph.entries.some((e) => e.html === disk.html))
      note("UNACCOUNTED_HTML", `${disk.html} on disk but not in graph`);
  }
  for (const chunk of graph.chunks) {
    if (!onDisk.has(chunk.file)) {
      note("MISSING_CHUNK", `${chunk.file} listed in graph but absent on disk`);
      continue;
    }
    const disk = diskChunks.get(chunk.file);
    const same = (a, b) =>
      JSON.stringify([...new Set(a)].sort()) ===
      JSON.stringify([...new Set(b)].sort());
    if (!same(chunk.imports, disk.static))
      note(
        "STATIC_EDGE_MISMATCH",
        `${chunk.file}: graph ${JSON.stringify(chunk.imports)} vs disk ${JSON.stringify([...disk.static].sort())}`,
      );
    if (!same(chunk.dynamicImports, disk.dynamic))
      note(
        "DYNAMIC_EDGE_MISMATCH",
        `${chunk.file}: graph ${JSON.stringify(chunk.dynamicImports)} vs disk ${JSON.stringify([...disk.dynamic].sort())}`,
      );
    for (const ref of [
      ...chunk.imports,
      ...chunk.dynamicImports,
      ...chunk.importedCss,
      ...chunk.importedAssets,
    ]) {
      if (!onDisk.has(ref))
        note(
          "MISSING_REFERENCE",
          `${chunk.file} references ${ref}, absent on disk`,
        );
    }
  }
  // A JS file is accounted for as a chunk, a worker variant, a public file,
  // or a bundled asset (a dedicated web worker Vite emits as an asset).
  const knownJs = new Set([
    ...graphChunks.keys(),
    ...graph.workers.map((w) => w.file),
    ...graph.publicFiles.map((p) => p.file.replace(/\/\*\*$/, "")),
    ...(graph.assets ?? []).map((a) => a.file),
  ]);
  for (const file of diskChunks.keys()) {
    const covered = [...knownJs].some(
      (k) => file === k || file.startsWith(`${k}/`),
    );
    if (!covered)
      note(
        "UNACCOUNTED_CHUNK",
        `${file} on disk but in no graph chunk, worker or public file`,
      );
  }
  for (const [file, list] of externals)
    note("EXTERNAL_IMPORT", `${file} imports outside dist: ${list.join(", ")}`);

  // Re-run the invariants over the disk edges with the graph's classifications.
  const diskGraph = {
    ...graph,
    entries: diskEntries,
    chunks: graph.chunks.map((c) => {
      const disk = diskChunks.get(c.file);
      return disk
        ? {
            ...c,
            imports: [...disk.static].sort(),
            dynamicImports: [...disk.dynamic].sort(),
          }
        : c;
    }),
    workers: graph.workers.map((w) => ({ ...w, present: onDisk.has(w.file) })),
    publicFiles: graph.publicFiles.map((p) => ({
      ...p,
      present: [...onDisk].some(
        (f) =>
          f === p.file || f.startsWith(`${p.file.replace(/\/\*\*$/, "")}/`),
      ),
    })),
  };
  const distributed = new Set(distribution.capabilityIds);
  const found = violations(diskGraph, distributed, mode, {
    coreCapabilities: new Set(graph.coreCapabilities ?? []),
  });

  // BUILD-04: physically absent.
  const expectAbsent = (options.expectAbsent ?? []).map((moduleId) => {
    const capability = moduleId.includes("/")
      ? moduleId.slice(0, moduleId.indexOf("/"))
      : moduleId;
    const inChunk = graph.chunks
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
      absent: inChunk.length === 0 && chunkFiles.length === 0 && !inTable,
      chunks: inChunk,
      files: chunkFiles,
      inTable,
    };
  });
  for (const check of expectAbsent) {
    if (!check.absent)
      note(
        "EXPECTED_ABSENT",
        `${check.module} is still present: ${JSON.stringify({ chunks: check.chunks, files: check.files, inTable: check.inTable })}`,
      );
  }

  // Sizes.
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
    if (ext === ".js" || ext === ".mjs") {
      sizes.javascript += bytes.byteLength;
      sizes.javascriptGzip += gzipSync(bytes, { level: 9 }).byteLength;
      const cap = file.match(/^assets\/cap-(.+)-[A-Za-z0-9_-]{8}\.js$/);
      if (cap)
        sizes.capabilityChunks[cap[1]] =
          (sizes.capabilityChunks[cap[1]] ?? 0) + bytes.byteLength;
    } else if (ext === ".css") sizes.css += bytes.byteLength;
  }
  const coreEntries = {
    ...diskGraph,
    entries: diskEntries.filter((e) => e.capability === null),
    workers: [],
  };
  for (const [, { chunks }] of entryClosure(coreEntries, {
    staticOnly: true,
  })) {
    for (const file of chunks) {
      if (!onDisk.has(file)) continue;
      const bytes = readFileSync(join(dist, file));
      sizes.entryStatic += bytes.byteLength;
      sizes.entryStaticGzip += gzipSync(bytes, { level: 9 }).byteLength;
    }
  }

  const errors = [
    ...mismatches,
    ...found.filter((v) => v.severity === "error"),
  ];
  const report = {
    ok: errors.length === 0,
    dist: relative(APP_ROOT, dist),
    mode,
    profile: graph.profile,
    distributionId: distribution.distributionId,
    inventorySource: graph.inventorySource ?? null,
    capabilityIds: distribution.capabilityIds,
    moduleIds: distribution.moduleIds,
    workers: diskGraph.workers,
    violations: found,
    mismatches,
    expectAbsent,
    unclassified: graph.unclassified ?? [],
    sizes,
  };
  return {
    report,
    table: formatViolations([
      ...mismatches.map((m) => ({ ...m, module: "-", chunk: "-", entry: "-" })),
      ...found,
    ]),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = parseArgs(process.argv.slice(2));
  const { report, table } = await verifyDist(args);
  if (!args.quiet) console.error(table);
  if (args.out)
    writeFileSync(resolve(APP_ROOT, args.out), canonicalJson(report));
  console.log(canonicalJson(report));
  process.exit(report.ok ? 0 : 1);
}
