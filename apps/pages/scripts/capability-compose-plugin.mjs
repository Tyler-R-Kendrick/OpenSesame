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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  publicPathTarget,
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
export async function loadInventory(
  appRoot = DEFAULT_APP_ROOT,
  { alias, lenient = false, logger = console } = {},
) {
  const present = Object.fromEntries(
    Object.entries(INVENTORY_FILES).map(([key, file]) => [
      key,
      existsSync(join(appRoot, file)),
    ]),
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
  // A file that exists but fails to evaluate is fatal unless `lenient` (the
  // report gate): a broken authored inventory must not silently revert to
  // the bootstrap guess in an enforced build.
  const load = async (key, apply) => {
    const file = INVENTORY_FILES[key];
    if (!present[key]) {
      inventory.missing.push(file);
      return;
    }
    try {
      apply(await server.ssrLoadModule(join(appRoot, file)));
    } catch (error) {
      if (!lenient) throw error;
      inventory.missing.push(
        `${file} (failed to load: ${error.message.split("\n")[0]})`,
      );
      logger.warn(
        `[capability-compose] ${file} failed to load; using the bootstrap ${key}: ${error.message.split("\n")[0]}`,
      );
    }
  };
  try {
    await load("catalog", (m) => {
      inventory.catalog =
        m.CAPABILITY_CATALOG ?? m.default ?? inventory.catalog;
    });
    await load("ownership", (m) => {
      inventory.moduleOwnership = m.MODULE_OWNERSHIP ?? {};
      inventory.htmlEntryOwnership = m.HTML_ENTRY_OWNERSHIP ?? {};
      inventory.publicFileOwnership = m.PUBLIC_FILE_OWNERSHIP ?? {};
      if (Array.isArray(m.WORKER_VARIANTS))
        inventory.workerVariants = m.WORKER_VARIANTS;
    });
    await load("classification", (m) => {
      inventory.classification =
        m.SOURCE_CLASSIFICATION ?? m.default ?? inventory.classification;
    });
  } finally {
    await server.close();
  }
  inventory.source = inventory.missing.length === 0 ? "authored" : "mixed";
  return inventory;
}

function readVersion(appRoot) {
  try {
    return (
      JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version ??
      "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
}

/** Everything the two plugins share, computed once in the `config` hook. */
async function composeState(options, userConfig, command = "build") {
  const appRoot = options.appRoot ?? DEFAULT_APP_ROOT;
  const repoRoot = options.repoRoot ?? resolve(appRoot, "../..");
  const variables = options.env ?? process.env;
  const env = resolveBuildEnvironment(variables);
  const mode = options.mode ?? env.mode;
  // The dev server is a debugging surface, not a merge gate: unless the gate
  // is named explicitly it reports, so a tree whose module owners have not
  // landed still serves.
  const gate =
    options.gate ??
    (variables.OPENSESAME_GRAPH_GATE || command === "build"
      ? env.gate
      : "report");
  const profilePath = options.profilePath ?? env.profilePath;
  const profile = profilePath
    ? loadProfile(profilePath, appRoot)
    : IMPLICIT_PROFILE;
  const inventory =
    options.inventory ??
    (await (options.loadInventory ?? loadInventory)(appRoot, {
      alias: userConfig?.resolve?.alias,
      lenient: gate === "report",
      logger: options.logger ?? console,
    }));
  const sets = distributedCapabilities(inventory.catalog, profile, mode);
  const isExcluded = (capability) =>
    capability !== null &&
    sets.all.has(capability) &&
    !sets.distributed.has(capability);
  const modules = normalizeModuleOwnership(
    inventory.moduleOwnership,
    inventory.catalog,
  );
  const diagnostics = [];
  for (const record of modules) {
    if (!sets.all.has(record.capability))
      diagnostics.push(
        `module "${record.id}" is owned by unknown capability "${record.capability}"`,
      );
  }
  let table = modules
    .filter((m) => sets.distributed.has(m.capability) && m.entry !== null)
    .map((m) => ({
      ...m,
      absolute: isAbsolute(m.entry) ? m.entry : resolve(appRoot, m.entry),
    }));
  const absent = table.filter((m) => !existsSync(m.absolute));
  if (gate === "enforce") {
    for (const m of absent)
      diagnostics.push(`module "${m.id}" entry file is absent: ${m.entry}`);
  } else if (absent.length > 0) {
    // Report mode is the diagnostic run over a tree whose module owners have
    // not landed yet: drop what is absent from the table and say so.
    (options.logger ?? console).warn(
      `[capability-compose] report gate: ${absent.length} module entr${absent.length === 1 ? "y" : "ies"} absent, dropped from MODULE_TABLE: ${absent.map((m) => m.id).join(", ")}`,
    );
    table = table.filter((m) => existsSync(m.absolute));
  }
  const htmlEntries = normalizeFileOwnership(inventory.htmlEntryOwnership);
  const publicFiles = normalizeFileOwnership(inventory.publicFileOwnership);
  for (const { path, capability } of [...htmlEntries, ...publicFiles]) {
    if (capability !== null && !sets.all.has(capability))
      diagnostics.push(
        `"${path}" is owned by unknown capability "${capability}"`,
      );
  }
  if (diagnostics.length > 0)
    throw new InvalidProfileError(
      `capability inventory rejects profile "${profile.name}"`,
      diagnostics,
    );
  const workerVariants = inventory.workerVariants ?? undefined;
  assertWorkerVariantsCover(
    inventory.catalog,
    sets.distributed,
    workerVariants,
  );
  const moduleIds = table.map((m) => m.id).sort();
  const contract = {
    distributionId: distributionId({
      mode,
      moduleIds,
      profileName: profile.name,
      version: readVersion(appRoot),
    }),
    mode,
    capabilityIds: [...sets.distributed].sort(),
    moduleIds,
    workerVariants: contractWorkerVariants(
      sets.distributed,
      inventory.catalog,
      workerVariants,
    ),
    basePath: userConfig?.base ?? "/",
  };
  const rules = inventory.classification;
  const classify = (id) => classifyModule(id, rules, { repoRoot });
  const workers = workerVariantsFor(
    sets.distributed,
    inventory.catalog,
    workerVariants,
  );
  return {
    appRoot,
    repoRoot,
    mode,
    gate,
    profile,
    inventory,
    sets,
    isExcluded,
    table,
    htmlEntries,
    publicFiles,
    contract,
    classify,
    workers,
  };
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
  if (!build.rollupOptions) build.rollupOptions = {};
  const rollupOptions = build.rollupOptions;
  if (!rollupOptions.output) rollupOptions.output = {};
  const outputs = Array.isArray(rollupOptions.output)
    ? rollupOptions.output
    : [rollupOptions.output];
  for (const output of outputs) {
    const previous =
      typeof output.manualChunks === "function" ? output.manualChunks : null;
    output.manualChunks = (id, api) => {
      if (
        !id.startsWith("\0") &&
        !/\.(css|scss|sass|less|styl)(\?|$)/.test(id)
      ) {
        const entry = state.classify(id);
        if (entry.classification === "optional" && entry.capability)
          return `cap-${entry.capability}`;
      }
      return previous ? previous(id, api) : undefined;
    };
  }
}

function moduleTableSource(state, command) {
  const lines = state.table.map((m) => {
    const specifier =
      command === "serve" ? `/@fs${toPosix(m.absolute)}` : toPosix(m.absolute);
    return `  ${JSON.stringify(m.id)}: () => import(${JSON.stringify(specifier)}),`;
  });
  return `export const MODULE_TABLE = Object.freeze({\n${lines.join("\n")}\n});\n`;
}

/** Exported for the plugin's own tests; the shape is documented in capability-graph.mjs. */
export function buildGraph(ctx, bundle, state, base) {
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
  for (const [file, output] of Object.entries(bundle).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
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
          .map((id) => ({
            ...classify(id),
            size: output.modules[id].renderedLength,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      });
      continue;
    }
    const size =
      typeof output.source === "string"
        ? Buffer.byteLength(output.source)
        : output.source.byteLength;
    if (file.endsWith(".html") && typeof output.source === "string") {
      const owner = state.htmlEntries.find((e) => e.path === file);
      entries.push({
        html: file,
        capability: owner?.capability ?? null,
        ...parseHtmlEntry(output.source, { base, htmlFile: file }),
      });
    } else assets.push({ file, size });
  }
  const moduleEdges = [];
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
        moduleEdges.push({
          from: from.id,
          to: to.id,
          toCapability: to.capability,
          kind,
          viaTable: id === tableId,
        });
      }
    }
  }
  moduleEdges.sort((a, b) =>
    `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`),
  );
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

function gateOrReport(state, graph, logger, stage) {
  const found = violations(graph, state.sets.distributed, state.mode, {
    coreCapabilities: state.sets.core,
  });
  const errors = found.filter((v) => v.severity === "error");
  const table = formatViolations(found);
  if (found.length > 0)
    logger.warn(
      `[capability-compose] ${stage} (${state.mode}, profile ${state.profile.name}, gate ${state.gate})\n${table}`,
    );
  if (errors.length > 0 && state.gate === "enforce") {
    throw new Error(
      `[capability-compose] forbidden reachability: ${errors.length} violation(s)\n${table}`,
    );
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
    /** Test seam: the state the `config` hook computed. */
    __state: () => state,
    async config(userConfig, env) {
      // Vitest resolves this config for every test run; the virtual modules
      // are substituted through the loader/store seams there and never
      // evaluated (virtual.d.ts), so the plugin stays inert under test.
      if (env?.mode === "test" || (options.env ?? process.env).VITEST) return;
      state = await composeState(options, userConfig, env?.command);
      if (!userConfig.build) userConfig.build = {};
      const build = userConfig.build;
      pruneInputs(build, state);
      installManualChunks(build, state);
      return {
        define: {
          "import.meta.env.OPENSESAME_BUILD_MODE": JSON.stringify(state.mode),
          "import.meta.env.OPENSESAME_CAPABILITY_PROFILE": JSON.stringify(
            state.profile.name,
          ),
        },
      };
    },
    configResolved(config) {
      resolved = config;
      if (!state) return;
      state.contract = { ...state.contract, basePath: config.base };
      if (state.inventory.source !== "authored") {
        config.logger.warn(
          `[capability-compose] inventory is ${state.inventory.source}; missing: ${state.inventory.missing.join(", ")}`,
        );
      }
    },
    resolveId(id) {
      return state && virtualIds.has(id) ? `\0${id}` : null;
    },
    load(id) {
      if (!state) return null;
      if (id === `\0${VIRTUAL_MODULES.table}`)
        return moduleTableSource(state, resolved.command);
      if (id === `\0${VIRTUAL_MODULES.distribution}`)
        return `export const DISTRIBUTION = Object.freeze(${JSON.stringify(state.contract)});\n`;
      return null;
    },
    closeBundle: {
      sequential: true,
      handler() {
        if (!state || state.mode !== "hardened" || resolved.command !== "build")
          return;
        for (const file of state.publicFiles) {
          if (state.isExcluded(file.capability))
            rmSync(join(outDir(), publicPathTarget(file.path)), {
              force: true,
              recursive: true,
            });
        }
      },
    },
  };

  const post = {
    name: "opensesame-capability-compose:graph",
    enforce: "post",
    apply: "build",
    generateBundle(outputOptions, bundle) {
      if (!state) return;
      graph = buildGraph(this, bundle, state, resolved.base);
      try {
        gateOrReport(state, graph, logger(), "generateBundle");
      } catch (error) {
        writeGraph(outDir(), graph);
        throw error;
      }
      this.emitFile({
        type: "asset",
        fileName: "capability-graph.json",
        source: canonicalJson(graph),
      });
      this.emitFile({
        type: "asset",
        fileName: "capability-distribution.json",
        source: canonicalJson(state.contract),
      });
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
        graph.workers = graph.workers.map((w) => ({
          ...w,
          size: stat(w.file),
          present: stat(w.file) !== null,
        }));
        graph.publicFiles = graph.publicFiles.map((p) => {
          const size = stat(publicPathTarget(p.file));
          return { ...p, size, present: size !== null };
        });
        for (const file of state.publicFiles) {
          if (
            state.isExcluded(file.capability) &&
            stat(publicPathTarget(file.path)) !== null
          )
            throw new Error(
              `[capability-compose] excluded public file survived: ${file.path}`,
            );
        }
        writeGraph(dist, graph);
        gateOrReport(state, graph, logger(), "closeBundle");
      },
    },
  };
  return [main, post];
}
