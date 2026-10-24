/**
 * Build `dist/capability-graph.json` from Rollup's bundle: one record per
 * chunk with its classified modules, the HTML entries, the emitted assets and
 * the core→optional module edges. Split out of the plugin so both stay inside
 * the 400-line budget (ADR 0093). The shape is documented in
 * `capability-graph.mjs`.
 */
import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { publicPathTarget } from "./capability-distribution.mjs";
import {
  VIRTUAL_MODULES,
  isUnclassified,
  parseHtmlEntry,
  workerRealmSource,
} from "./capability-graph.mjs";
import { secretBackendSdkChunk } from "./capability-lazy-leaves.mjs";
import { itemTypePackChunk } from "./item-type-pack-chunks.mjs";

// Rollup OutputAsset.source is an I/O boundary, not an unchecked coercion.
const rollupAssetSource = z.union([z.string(), z.instanceof(Uint8Array)]);
const htmlUtf8 = new TextDecoder("utf-8", { fatal: true });
function assetBytes(source) {
  return Buffer.from(rollupAssetSource.parse(source));
}

/**
 * Whether an owned public file will be in the output: emitted into the bundle
 * by a plugin, or copied from `public/`. A file a later step writes after the
 * build (`.well-known/**`) is not, and an excluded capability's file that
 * nothing emits is no violation. `undefined`, with no app root to look in,
 * keeps the gate as conservative as it was; `measureEmittedFiles` replaces
 * either with what `dist/` holds once the build has finished.
 */
function publicFilePresent(state, bundle, path) {
  const target = publicPathTarget(path);
  const emitted = Object.keys(bundle).some(
    (file) => file === target || file.startsWith(`${target}/`),
  );
  if (emitted) return true;
  if (state.appRoot === undefined) return undefined;
  return existsSync(join(state.appRoot, "public", target));
}

/** One chunk record: its edges, its CSS/asset references and its modules. */
function chunkRecord(file, output, classify) {
  return {
    file,
    name: output.name,
    isEntry: output.isEntry,
    isDynamicEntry: output.isDynamicEntry,
    // Type packs install individually (ADR 0165); native SDKs initialize on demand.
    // Approving a capability must not eagerly cache these optional resources.
    onDemand: Object.keys(output.modules).some(
      (id) =>
        itemTypePackChunk(id) !== undefined ||
        secretBackendSdkChunk(workerRealmSource(id) ?? id, classify(id)) !==
          undefined,
    ),
    imports: [...new Set(output.imports)].sort(),
    dynamicImports: [...new Set(output.dynamicImports)].sort(),
    importedCss: [...(output.viteMetadata?.importedCss ?? [])].sort(),
    importedAssets: [...(output.viteMetadata?.importedAssets ?? [])].sort(),
    modules: Object.keys(output.modules)
      .map((id) => ({
        ...classify(id),
        size: output.modules[id].renderedLength,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

/** Split the bundle into chunk records, HTML entries and plain assets. */
function collectOutputs(bundle, state, base, classify) {
  const chunks = [];
  const assets = [];
  const entries = [];
  const moduleWorkers = [];
  for (const [file, output] of Object.entries(bundle).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    if (output.type === "chunk") {
      chunks.push(chunkRecord(file, output, classify));
      continue;
    }
    if (output.opensesameWorkerChunk) {
      const worker = output.opensesameWorkerChunk;
      if (
        worker.code !== output.source ||
        worker.fileName !== file ||
        !Object.keys(worker.modules).some((id) => workerRealmSource(id))
      )
        throw new Error("Worker asset bytes or source metadata differ.");
      chunks.push(chunkRecord(file, worker, classify));
      if (worker.isEntry) {
        if (!workerRealmSource(worker.facadeModuleId))
          throw new Error("Worker asset needs its original entry source.");
        moduleWorkers.push({
          variant: `module:${worker.name}`,
          file,
          capability: classify(worker.facadeModuleId).capability,
        });
      }
    }
    const source = assetBytes(output.source);
    if (file.endsWith(".html")) {
      const owner =
        state.htmlEntries.find((e) => e.path === file) ??
        state.publicFiles.find((entry) => entry.path === file);
      entries.push({
        html: file,
        capability: owner?.capability ?? null,
        ...parseHtmlEntry(htmlUtf8.decode(source), { base, htmlFile: file }),
      });
      continue;
    }
    assets.push({
      file,
      size: source.byteLength,
    });
  }
  return { chunks, assets, entries, moduleWorkers };
}

/** Public copying bypasses Rollup's bundle; only precisely owned HTML is an entry. */
function copiedPublicEntries(state, bundle, entries, base) {
  for (const file of state.publicFiles) {
    if (
      !file.path.endsWith(".html") ||
      entries.some((entry) => entry.html === file.path)
    )
      continue;
    if (state.mode === "hardened" && state.isExcluded(file.capability))
      continue;
    const source =
      state.appRoot === undefined
        ? null
        : join(state.appRoot, "public", file.path);
    const emitted = bundle[file.path];
    let html;
    if (emitted?.type === "asset") {
      html = htmlUtf8.decode(assetBytes(emitted.source));
    } else if (source && existsSync(source))
      html = htmlUtf8.decode(readFileSync(source));
    else continue;
    entries.push({
      html: file.path,
      capability: file.capability,
      ...parseHtmlEntry(html, { base, htmlFile: file.path }),
    });
  }
}

/** Every core→optional import edge, and whether it went through MODULE_TABLE. */
function collectModuleEdges(ctx, classify) {
  const edges = [];
  const tableId = `\0${VIRTUAL_MODULES.table}`;
  for (const id of ctx.getModuleIds()) {
    const from = classify(id);
    if (from.classification === "optional") continue;
    const info = ctx.getModuleInfo(id);
    if (!info) continue;
    for (const [kind, targets] of [
      ["static", info.importedIds],
      ["dynamic", info.dynamicallyImportedIds],
    ]) {
      for (const target of targets) {
        const to = classify(target);
        if (to.classification !== "optional") continue;
        edges.push({
          from: from.id,
          to: to.id,
          toCapability: to.capability,
          kind,
          viaTable: id === tableId,
        });
      }
    }
  }
  return edges.sort((a, b) =>
    `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`),
  );
}

/** Exported for the plugin's own tests; the shape is documented in capability-graph.mjs. */
export function buildGraph(ctx, bundle, state, base) {
  const unclassified = new Set();
  const classified = new Map();
  const classify = (id) => {
    let entry = classified.get(id);
    if (!entry) {
      entry = state.classify(id);
      classified.set(id, entry);
      if (isUnclassified(entry)) unclassified.add(entry.id);
    }
    return entry;
  };
  const { chunks, assets, entries, moduleWorkers } = collectOutputs(
    bundle,
    state,
    base,
    classify,
  );
  copiedPublicEntries(state, bundle, entries, base);
  const moduleEdges = collectModuleEdges(ctx, classify);
  return {
    distributionId: state.contract.distributionId,
    mode: state.mode,
    profile: state.profile.name,
    profileExpectInvalid: state.profile.expectInvalid,
    profileNotes: state.sets.notes,
    coreCapabilities: [...state.sets.core].sort(),
    inventorySource: state.inventory.source,
    generatedAt: null,
    entries,
    chunks,
    assets,
    workers: [
      ...state.workers.map((v) => ({
        variant: v.id,
        file: v.scriptPath,
        capability: v.capability,
      })),
      ...moduleWorkers,
    ],
    publicFiles: state.publicFiles.map((p) => ({
      file: p.path,
      capability: p.capability,
      present: publicFilePresent(state, bundle, p.path),
    })),
    moduleEdges,
    unclassified: [...unclassified].sort(),
  };
}
