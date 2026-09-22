/**
 * Build `dist/capability-graph.json` from Rollup's bundle: one record per
 * chunk with its classified modules, the HTML entries, the emitted assets and
 * the core→optional module edges. Split out of the plugin so both stay inside
 * the 400-line budget (ADR 0093). The shape is documented in
 * `capability-graph.mjs`.
 */
import {
  VIRTUAL_MODULES,
  isUnclassified,
  parseHtmlEntry,
} from "./capability-graph.mjs";

/** One chunk record: its edges, its CSS/asset references and its modules. */
function chunkRecord(file, output, classify) {
  return {
    file,
    name: output.name,
    isEntry: output.isEntry,
    isDynamicEntry: output.isDynamicEntry,
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
  for (const [file, output] of Object.entries(bundle).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    if (output.type === "chunk") {
      chunks.push(chunkRecord(file, output, classify));
      continue;
    }
    if (file.endsWith(".html") && typeof output.source === "string") {
      const owner = state.htmlEntries.find((e) => e.path === file);
      entries.push({
        html: file,
        capability: owner?.capability ?? null,
        ...parseHtmlEntry(output.source, { base, htmlFile: file }),
      });
      continue;
    }
    assets.push({
      file,
      size:
        typeof output.source === "string"
          ? Buffer.byteLength(output.source)
          : output.source.byteLength,
    });
  }
  return { chunks, assets, entries };
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
  const { chunks, assets, entries } = collectOutputs(
    bundle,
    state,
    base,
    classify,
  );
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
    workers: state.workers.map((v) => ({
      variant: v.id,
      file: v.scriptPath,
      capability: v.capability,
    })),
    publicFiles: state.publicFiles.map((p) => ({
      file: p.path,
      capability: p.capability,
    })),
    moduleEdges,
    unclassified: [...unclassified].sort(),
  };
}
