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
 *
 * The disk reading, comparison and measurement live in
 * `lib/verify-dist-checks.mjs`; this file is the orchestration and the CLI.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "./lib/capability-graph.mjs";
import { formatViolations, violations } from "./lib/capability-invariants.mjs";
import {
  compareGraphToDisk,
  diskGraphOf,
  expectAbsentChecks,
  loadLexer,
  measureSizes,
  readDiskView,
  walk,
} from "./lib/verify-dist-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(APP_ROOT, "../..");

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

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Read the two records a build emits, or say which one is missing. */
function readRecords(dist) {
  if (!existsSync(dist)) throw new Error(`dist directory not found: ${dist}`);
  const graphPath = join(dist, "capability-graph.json");
  const distributionPath = join(dist, "capability-distribution.json");
  for (const path of [graphPath, distributionPath]) {
    if (!existsSync(path))
      throw new Error(`missing ${relative(dist, path)} in ${dist}`);
  }
  return {
    graph: readJson(graphPath),
    distribution: readJson(distributionPath),
  };
}

/** The graph, the contract and the caller's expectations must agree. */
function checkRecordAgreement(graph, distribution, options, mode, note) {
  if (graph.mode !== mode)
    note("MODE_MISMATCH", `graph says ${graph.mode}, expected ${mode}`);
  if (graph.distributionId !== distribution.distributionId)
    note("DISTRIBUTION_ID_MISMATCH", "graph and contract disagree");
  if (!options.profile) return;
  const expected =
    JSON.parse(readFileSync(resolve(APP_ROOT, options.profile), "utf8")).name ??
    posix.basename(options.profile, ".json");
  if (graph.profile !== expected)
    note(
      "PROFILE_MISMATCH",
      `graph built from ${graph.profile}, expected ${expected}`,
    );
}

export async function verifyDist(options) {
  const dist = resolve(APP_ROOT, options.dist);
  const { graph, distribution } = readRecords(dist);
  const base = options.base ?? distribution.basePath ?? "/";
  const mode = options.mode ?? graph.mode;
  const mismatches = [];
  const note = (code, message) =>
    mismatches.push({ severity: "error", code, message });
  checkRecordAgreement(graph, distribution, options, mode, note);

  const { init, parse } = await loadLexer(REPO_ROOT);
  await init;
  const files = walk(dist).map((f) => relative(dist, f).split("\\").join("/"));
  const onDisk = new Set(files);
  const disk = readDiskView(dist, files, graph, base, parse);
  compareGraphToDisk(graph, disk, onDisk, note);

  // Re-run the invariants over the disk edges with the graph's classifications.
  const diskGraph = diskGraphOf(graph, disk, onDisk);
  const found = violations(
    diskGraph,
    new Set(distribution.capabilityIds),
    mode,
    { coreCapabilities: new Set(graph.coreCapabilities ?? []) },
  );

  const expectAbsent = expectAbsentChecks(
    options.expectAbsent ?? [],
    graph,
    distribution,
    files,
  );
  for (const check of expectAbsent) {
    if (!check.absent)
      note(
        "EXPECTED_ABSENT",
        `${check.module} is still present: ${JSON.stringify({ chunks: check.chunks, files: check.files, inTable: check.inTable })}`,
      );
  }

  const sizes = measureSizes(dist, files, graph, diskGraph, onDisk);
  const errors = [
    ...mismatches,
    ...found.filter((v) => v.severity === "error"),
  ];
  return {
    report: {
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
    },
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
