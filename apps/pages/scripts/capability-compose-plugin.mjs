/**
 * Vite plugin: operator-controlled capability composition at build time
 * (docs/implementation/capability-composition/ownership.md §4.6).
 *
 *   OPENSESAME_CAPABILITY_PROFILE=<path>   profile JSON; absent → rich-explicit
 *   OPENSESAME_BUILD_MODE=selective|hardened   default selective
 *   OPENSESAME_GRAPH_GATE=enforce|report       default enforce
 *
 * Provides `virtual:opensesame-capability-modules` (the MODULE_TABLE of
 * compile-time-literal dynamic imports, distributed modules only) and
 * `virtual:opensesame-distribution` (the DistributionContract); drops HTML
 * entries and public files owned by an excluded capability in hardened mode;
 * partitions every optional module into a `cap-<capability>` chunk; emits
 * `dist/capability-graph.json` and `dist/capability-distribution.json`; and
 * fails the build on forbidden reachability (BUILD-01/02/06, EVID-01/02).
 *
 * `capabilityCompose()` returns two plugins: a normal-order one (config,
 * virtual modules, public-file pruning before vite-plugin-pwa globs the
 * precache manifest) and an `enforce: "post"` one (graph + gate, after the
 * HTML plugin has emitted the documents and the worker has been built).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IMPLICIT_PROFILE,
  InvalidProfileError,
  assertWorkerVariantsCover,
  contractWorkerVariants,
  distributedCapabilities,
  distributionId,
  loadProfile,
  normalizeFileOwnership,
  normalizeModuleOwnership,
  resolveBuildEnvironment,
  workerVariantsFor,
} from "./lib/capability-distribution.mjs";
import {
  VIRTUAL_MODULES,
  canonicalJson,
  classifyModule,
  formatViolations,
  isUnclassified,
  parseHtmlEntry,
  violations,
} from "./lib/capability-graph.mjs";
import { FALLBACK_INVENTORY } from "./lib/capability-inventory-fallback.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_ROOT = resolve(here, "..");
const INVENTORY_FILES = {
  catalog: "src/lib/capabilities/catalog.ts",
  ownership: "src/lib/capabilities/ownership.ts",
  classification: "src/lib/capabilities/classification.ts",
};
const toPosix = (path) => path.replace(/\\/g, "/");

/**
 * Load S02's authored inventory through Vite's own module pipeline (so the
 * `.js`→`.ts` extension convention and workspace aliases resolve). Any file
 * still absent falls back to the bootstrap inventory, and `source` says so.
 */
export async function loadInventory(appRoot = DEFAULT_APP_ROOT, { alias } = {}) {
  const present = Object.fromEntries(
    Object.entries(INVENTORY_FILES).map(([key, file]) => [key, existsSync(join(appRoot, file))]),
  );
  const inventory = { ...FALLBACK_INVENTORY, source: "fallback", missing: [] };
  if (!Object.values(present).some(Boolean)) {
    inventory.missing = Object.values(INVENTORY_FILES);
    return inventory;
  }
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: false,
    envFile: false,
    root: appRoot,
    logLevel: "error",
    appType: "custom",
    resolve: alias ? { alias } : undefined,
    ssr: { noExternal: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  try {
    const load = (file) => server.ssrLoadModule(join(appRoot, file));
    if (present.catalog) {
      const m = await load(INVENTORY_FILES.catalog);
      inventory.catalog = m.CAPABILITY_CATALOG ?? m.default ?? inventory.catalog;
    } else inventory.missing.push(INVENTORY_FILES.catalog);
    if (present.ownership) {
      const m = await load(INVENTORY_FILES.ownership);
      inventory.moduleOwnership = m.MODULE_OWNERSHIP ?? {};
      inventory.htmlEntryOwnership = m.HTML_ENTRY_OWNERSHIP ?? {};
      inventory.publicFileOwnership = m.PUBLIC_FILE_OWNERSHIP ?? {};
    } else inventory.missing.push(INVENTORY_FILES.ownership);
    if (present.classification) {
      const m = await load(INVENTORY_FILES.classification);
      inventory.classification = m.SOURCE_CLASSIFICATION ?? m.default ?? inventory.classification;
    } else inventory.missing.push(INVENTORY_FILES.classification);
  } finally {
    await server.close();
  }
  inventory.source = inventory.missing.length === 0 ? "authored" : "mixed";
  return inventory;
}

function readVersion(appRoot) {
  try {
    return JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Everything the two plugins share, computed once in the `config` hook. */
async function composeState(options, userConfig) {
  const appRoot = options.appRoot ?? DEFAULT_APP_ROOT;
  const repoRoot = options.repoRoot ?? resolve(appRoot, "../..");
  const env = resolveBuildEnvironment(options.env ?? process.env);
  const mode = options.mode ?? env.mode;
  const gate = options.gate ?? env.gate;
  const profilePath = options.profilePath ?? env.profilePath;
  const profile = profilePath ? loadProfile(profilePath, appRoot) : IMPLICIT_PROFILE;
  const inventory =
    options.inventory ??
    (await (options.loadInventory ?? loadInventory)(appRoot, { alias: userConfig?.resolve?.alias }));
  const sets = distributedCapabilities(inventory.catalog, profile, mode);
  const isExcluded = (capability) =>
    capability !== null && sets.all.has(capability) && !sets.distributed.has(capability);
  const modules = normalizeModuleOwnership(inventory.moduleOwnership, inventory.catalog);
  const diagnostics = [];
  for (const record of modules) {
    if (!sets.all.has(record.capability))
      diagnostics.push(`module "${record.id}" is owned by unknown capability "${record.capability}"`);
  }
  const table = modules
    .filter((m) => sets.distributed.has(m.capability) && m.entry !== null)
    .map((m) => ({ ...m, absolute: isAbsolute(m.entry) ? m.entry : resolve(appRoot, m.entry) }));
  for (const m of table) {
    if (!existsSync(m.absolute)) diagnostics.push(`module "${m.id}" entry file is absent: ${m.entry}`);
  }
  const htmlEntries = normalizeFileOwnership(inventory.htmlEntryOwnership);
  const publicFiles = normalizeFileOwnership(inventory.publicFileOwnership);
  for (const { path, capability } of [...htmlEntries, ...publicFiles]) {
    if (capability !== null && !sets.all.has(capability))
      diagnostics.push(`"${path}" is owned by unknown capability "${capability}"`);
  }
  if (diagnostics.length > 0)
    throw new InvalidProfileError(`capability inventory rejects profile "${profile.name}"`, diagnostics);
  assertWorkerVariantsCover(inventory.catalog, sets.distributed);
  const moduleIds = table.map((m) => m.id).sort();
  const contract = {
    distributionId: distributionId({ mode, moduleIds, profileName: profile.name, version: readVersion(appRoot) }),
    mode,
    capabilityIds: [...sets.distributed].sort(),
    moduleIds,
    workerVariants: contractWorkerVariants(sets.distributed),
    basePath: userConfig?.base ?? "/",
  };
  const rules = inventory.classification;
  const classify = (id) => classifyModule(id, rules, { repoRoot });
  return { appRoot, repoRoot, mode, gate, profile, inventory, sets, isExcluded, table, htmlEntries, publicFiles, contract, classify };
}

function pruneInputs(build, state) {
  const input = build.rollupOptions?.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  for (const [name, file] of Object.entries(input)) {
    const rel = toPosix(relative(state.appRoot, file));
    const owner = state.htmlEntries.find((e) => e.path === rel);
    if (owner && state.isExcluded(owner.capability)) delete input[name];
  }
}

function installManualChunks(build, state) {
  const rollupOptions = build.rollupOptions ?? (build.rollupOptions = {});
  const outputs = Array.isArray(rollupOptions.output)
    ? rollupOptions.output
    : [rollupOptions.output ?? (rollupOptions.output = {})];
  for (const output of outputs) {
    const previous = typeof output.manualChunks === "function" ? output.manualChunks : null;
    output.manualChunks = (id, api) => {
      if (!id.startsWith("\0") && !/\.(css|scss|sass|less|styl)(\?|$)/.test(id)) {
        const entry = state.classify(id);
        if (entry.classification === "optional" && entry.capability) return `cap-${entry.capability}`;
      }
      return previous ? previous(id, api) : undefined;
    };
  }
}

function moduleTableSource(state, command) {
  const lines = state.table.map((m) => {
    const specifier = command === "serve" ? `/@fs${toPosix(m.absolute)}` : toPosix(m.absolute);
    return `  ${JSON.stringify(m.id)}: () => import(${JSON.stringify(specifier)}),`;
  });
  return `export const MODULE_TABLE = Object.freeze({\n${lines.join("\n")}\n});\n`;
}

function buildGraph(ctx, bundle, state, base) {
  const chunks = [];
  const assets = [];
  const entries = [];
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
  for (const [file, output] of Object.entries(bundle).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (output.type === "chunk") {
      chunks.push({
        file,
        name: output.name,
        isEntry: output.isEntry,
        isDynamicEntry: output.isDynamicEntry,
        imports: [...output.imports].sort(),
        dynamicImports: [...output.dynamicImports].sort(),
        importedCss: [...(output.viteMetadata?.importedCss ?? [])].sort(),
        importedAssets: [...(output.viteMetadata?.importedAssets ?? [])].sort(),
        modules: Object.keys(output.modules)
          .map((id) => ({ ...classify(id), size: output.modules[id].renderedLength }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      });
      continue;
    }
    const size = typeof output.source === "string" ? Buffer.byteLength(output.source) : output.source.byteLength;
    if (file.endsWith(".html") && typeof output.source === "string") {
      const owner = state.htmlEntries.find((e) => e.path === file);
      entries.push({ html: file, capability: owner?.capability ?? null, ...parseHtmlEntry(output.source, { base, htmlFile: file }) });
    } else assets.push({ file, size });
  }
  const moduleEdges = [];
  const tableId = `\0${VIRTUAL_MODULES.table}`;
  for (const id of ctx.getModuleIds()) {
    const from = classify(id);
    if (from.classification === "optional") continue;
    const info = ctx.getModuleInfo(id);
    if (!info) continue;
    for (const [kind, targets] of [["static", info.importedIds], ["dynamic", info.dynamicallyImportedIds]]) {
      for (const target of targets) {
        const to = classify(target);
        if (to.classification !== "optional") continue;
        moduleEdges.push({ from: from.id, to: to.id, toCapability: to.capability, kind, viaTable: id === tableId });
      }
    }
  }
  moduleEdges.sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`));
  return {
    distributionId: state.contract.distributionId,
    mode: state.mode,
    profile: state.profile.name,
    inventorySource: state.inventory.source,
    generatedAt: null,
    entries,
    chunks,
    assets,
    workers: workerVariantsFor(state.sets.distributed).map((v) => ({ variant: v.id, file: v.scriptPath, capability: v.capability })),
    publicFiles: state.publicFiles.map((p) => ({ file: p.path, capability: p.capability })),
    moduleEdges,
    unclassified: [...unclassified].sort(),
  };
}

function gateOrReport(state, graph, logger, stage) {
  const found = violations(graph, state.sets.distributed, state.mode, { coreCapabilities: state.sets.core });
  const errors = found.filter((v) => v.severity === "error");
  const table = formatViolations(found);
  if (found.length > 0) logger.warn(`[capability-compose] ${stage} (${state.mode}, profile ${state.profile.name}, gate ${state.gate})\n${table}`);
  if (errors.length > 0 && state.gate === "enforce") {
    throw new Error(`[capability-compose] forbidden reachability: ${errors.length} violation(s)\n${table}`);
  }
  return found;
}

function writeGraph(outDir, graph) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "capability-graph.json"), canonicalJson(graph));
}

export function capabilityCompose(options = {}) {
  let state = null;
  let resolved = null;
  let graph = null;
  const outDir = () => resolve(resolved.root, resolved.build.outDir);
  const virtualIds = new Set(Object.values(VIRTUAL_MODULES));
  const logger = () => resolved?.logger ?? console;

  const main = {
    name: "opensesame-capability-compose",
    async config(userConfig) {
      state = await composeState(options, userConfig);
      const build = userConfig.build ?? (userConfig.build = {});
      pruneInputs(build, state);
      installManualChunks(build, state);
      return {
        define: {
          "import.meta.env.OPENSESAME_BUILD_MODE": JSON.stringify(state.mode),
          "import.meta.env.OPENSESAME_CAPABILITY_PROFILE": JSON.stringify(state.profile.name),
        },
      };
    },
    configResolved(config) {
      resolved = config;
      state.contract = { ...state.contract, basePath: config.base };
      if (state.inventory.source !== "authored") {
        config.logger.warn(`[capability-compose] inventory is ${state.inventory.source}; missing: ${state.inventory.missing.join(", ")}`);
      }
    },
    resolveId(id) {
      return virtualIds.has(id) ? `\0${id}` : null;
    },
    load(id) {
      if (id === `\0${VIRTUAL_MODULES.table}`) return moduleTableSource(state, resolved.command);
      if (id === `\0${VIRTUAL_MODULES.distribution}`) return `export const DISTRIBUTION = Object.freeze(${JSON.stringify(state.contract)});\n`;
      return null;
    },
    closeBundle: {
      sequential: true,
      handler() {
        if (state.mode !== "hardened" || resolved.command !== "build") return;
        for (const file of state.publicFiles) {
          if (state.isExcluded(file.capability)) rmSync(join(outDir(), file.path), { force: true, recursive: true });
        }
      },
    },
  };

  const post = {
    name: "opensesame-capability-compose:graph",
    enforce: "post",
    apply: "build",
    generateBundle(outputOptions, bundle) {
      graph = buildGraph(this, bundle, state, resolved.base);
      try {
        gateOrReport(state, graph, logger(), "generateBundle");
      } catch (error) {
        writeGraph(outDir(), graph);
        throw error;
      }
      this.emitFile({ type: "asset", fileName: "capability-graph.json", source: canonicalJson(graph) });
      this.emitFile({ type: "asset", fileName: "capability-distribution.json", source: canonicalJson(state.contract) });
    },
    closeBundle: {
      sequential: true,
      handler() {
        if (!graph) return;
        const dist = outDir();
        const stat = (file) => {
          try {
            return statSync(join(dist, file)).size;
          } catch {
            return null;
          }
        };
        graph.workers = graph.workers.map((w) => ({ ...w, size: stat(w.file), present: stat(w.file) !== null }));
        graph.publicFiles = graph.publicFiles.map((p) => ({ ...p, size: stat(p.file), present: stat(p.file) !== null }));
        for (const file of state.publicFiles) {
          if (state.isExcluded(file.capability) && stat(file.path) !== null)
            throw new Error(`[capability-compose] excluded public file survived: ${file.path}`);
        }
        writeGraph(dist, graph);
        gateOrReport(state, graph, logger(), "closeBundle");
      },
    },
  };
  return [main, post];
}
