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
  isUnclassified,
  parseHtmlEntry,
} from "./lib/capability-graph.mjs";
import {
  formatViolations,
  violations,
} from "./lib/capability-invariants.mjs";
import { FALLBACK_INVENTORY } from "./lib/capability-inventory-fallback.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_ROOT = resolve(here, "..");
const INVENTORY_FILES = {
  catalog: "src/lib/capabilities/catalog.ts",
  ownership: "src/lib/capabilities/ownership.ts",
  classification: "src/lib/capabilities/classification.ts",
};
const toPosix = (path) => path.replace(/\\/g, "/");

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

/** The graph ships (the worker reads it), so it is written compact. */
const graphJson = (graph) => canonicalJson(graph, 0);

function writeGraph(outDir, graph) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "capability-graph.json"), graphJson(graph));
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
        source: graphJson(graph),
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
