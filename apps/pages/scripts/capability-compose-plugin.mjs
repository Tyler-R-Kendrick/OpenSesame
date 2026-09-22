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
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildGraph } from "./lib/capability-build-graph.mjs";
import { composeState } from "./lib/capability-compose-state.mjs";
import { publicPathTarget } from "./lib/capability-distribution.mjs";
import { VIRTUAL_MODULES, canonicalJson } from "./lib/capability-graph.mjs";
import { formatViolations, violations } from "./lib/capability-invariants.mjs";

export { loadInventory } from "./lib/capability-compose-state.mjs";
export { buildGraph } from "./lib/capability-build-graph.mjs";

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

/**
 * Record what each worker variant and public file actually became on disk,
 * and refuse a hardened build in which an excluded public file survived.
 */
function measureEmittedFiles(state, graph, dist) {
  const stat = (file) => {
    try {
      return statSync(join(dist, file)).size;
    } catch {
      return null;
    }
  };
  graph.workers = graph.workers.map((w) => {
    const size = stat(w.file);
    return { ...w, size, present: size !== null };
  });
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
}

/** Config, virtual modules and hardened public-file pruning. */
function mainPlugin(options, ctx) {
  const virtualIds = new Set(Object.values(VIRTUAL_MODULES));
  return {
    name: "opensesame-capability-compose",
    /** Test seam: the state the `config` hook computed. */
    __state: () => ctx.state,
    async config(userConfig, env) {
      // Vitest resolves this config for every test run; the virtual modules
      // are substituted through the loader/store seams there and never
      // evaluated (virtual.d.ts), so the plugin stays inert under test.
      if (env?.mode === "test" || (options.env ?? process.env).VITEST) return;
      const state = await composeState(options, userConfig, env?.command);
      ctx.state = state;
      if (!userConfig.build) userConfig.build = {};
      pruneInputs(userConfig.build, state);
      installManualChunks(userConfig.build, state);
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
      ctx.resolved = config;
      if (!ctx.state) return;
      ctx.state.contract = { ...ctx.state.contract, basePath: config.base };
      if (ctx.state.inventory.source !== "authored") {
        config.logger.warn(
          `[capability-compose] inventory is ${ctx.state.inventory.source}; missing: ${ctx.state.inventory.missing.join(", ")}`,
        );
      }
    },
    resolveId(id) {
      return ctx.state && virtualIds.has(id) ? `\0${id}` : null;
    },
    load(id) {
      if (!ctx.state) return null;
      if (id === `\0${VIRTUAL_MODULES.table}`)
        return moduleTableSource(ctx.state, ctx.resolved.command);
      if (id === `\0${VIRTUAL_MODULES.distribution}`)
        return `export const DISTRIBUTION = Object.freeze(${JSON.stringify(ctx.state.contract)});\n`;
      return null;
    },
    closeBundle: {
      sequential: true,
      handler() {
        const { state, resolved } = ctx;
        if (!state || state.mode !== "hardened" || resolved.command !== "build")
          return;
        for (const file of state.publicFiles) {
          if (state.isExcluded(file.capability))
            rmSync(join(ctx.outDir(), publicPathTarget(file.path)), {
              force: true,
              recursive: true,
            });
        }
      },
    },
  };
}

/** The post-order half: the graph, the records it emits, and the gate. */
function graphPlugin(ctx) {
  return {
    name: "opensesame-capability-compose:graph",
    enforce: "post",
    apply: "build",
    generateBundle(_outputOptions, bundle) {
      const { state } = ctx;
      if (!state) return;
      ctx.graph = buildGraph(this, bundle, state, ctx.resolved.base);
      try {
        gateOrReport(state, ctx.graph, ctx.logger(), "generateBundle");
      } catch (error) {
        writeGraph(ctx.outDir(), ctx.graph);
        throw error;
      }
      this.emitFile({
        type: "asset",
        fileName: "capability-graph.json",
        source: graphJson(ctx.graph),
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
        const { state, graph } = ctx;
        if (!graph) return;
        const dist = ctx.outDir();
        measureEmittedFiles(state, graph, dist);
        writeGraph(dist, graph);
        gateOrReport(state, graph, ctx.logger(), "closeBundle");
      },
    },
  };
}

export function capabilityCompose(options = {}) {
  const ctx = {
    state: null,
    resolved: null,
    graph: null,
    outDir: () => resolve(ctx.resolved.root, ctx.resolved.build.outDir),
    logger: () => ctx.resolved?.logger ?? console,
  };
  return [mainPlugin(options, ctx), graphPlugin(ctx)];
}
