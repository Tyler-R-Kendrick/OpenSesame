/**
 * Everything the two capability-compose plugins share, computed once in the
 * `config` hook: the resolved build environment, S02's authored inventory,
 * the distributed-capability sets, the MODULE_TABLE rows and the
 * DistributionContract. Split out of the plugin so each stays readable and
 * inside the 400-line budget (ADR 0093).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
} from "./capability-distribution.mjs";
import { classifyModule } from "./capability-graph.mjs";
import { FALLBACK_INVENTORY } from "./capability-inventory-fallback.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// This module lives in `apps/pages/scripts/lib/`, so the app root is two up.
export const DEFAULT_APP_ROOT = resolve(here, "../..");
const INVENTORY_FILES = {
  catalog: "../../packages/app-core/src/lib/capabilities/catalog.ts",
  ownership: "src/lib/capabilities/ownership.ts",
  classification: "src/lib/capabilities/classification.ts",
};

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
/** The build variables, profile and gate this run is configured with. */
function resolveSettings(options, command) {
  const appRoot = options.appRoot ?? DEFAULT_APP_ROOT;
  const variables = options.env ?? process.env;
  const env = resolveBuildEnvironment(variables);
  // The dev server is a debugging surface, not a merge gate: unless the gate
  // is named explicitly it reports, so a tree whose module owners have not
  // landed still serves.
  const gate =
    options.gate ??
    (variables.OPENSESAME_GRAPH_GATE || command === "build"
      ? env.gate
      : "report");
  const profilePath = options.profilePath ?? env.profilePath;
  return {
    appRoot,
    repoRoot: options.repoRoot ?? resolve(appRoot, "../.."),
    mode: options.mode ?? env.mode,
    gate,
    // Whether a human named the gate, as opposed to inheriting the default.
    gateNamed:
      options.gate !== undefined || Boolean(variables.OPENSESAME_GRAPH_GATE),
    profile: profilePath ? loadProfile(profilePath, appRoot) : IMPLICIT_PROFILE,
  };
}

/**
 * The MODULE_TABLE rows: distributed, page-loadable modules whose entry file
 * exists. An absent entry is a build error under `enforce` and a dropped row
 * with a warning under `report` (the diagnostic run over a tree whose module
 * owners have not landed yet).
 */
function resolveModuleTable(inventory, sets, settings, logger, diagnostics) {
  const modules = normalizeModuleOwnership(
    inventory.moduleOwnership,
    inventory.catalog,
  );
  for (const record of modules) {
    if (!sets.all.has(record.capability))
      diagnostics.push(
        `module "${record.id}" is owned by unknown capability "${record.capability}"`,
      );
  }
  const table = modules
    .filter((m) => sets.distributed.has(m.capability) && m.entry !== null)
    .map((m) => ({
      ...m,
      absolute: isAbsolute(m.entry)
        ? m.entry
        : resolve(settings.appRoot, m.entry),
    }));
  const absent = table.filter((m) => !existsSync(m.absolute));
  if (settings.gate === "enforce") {
    for (const m of absent)
      diagnostics.push(`module "${m.id}" entry file is absent: ${m.entry}`);
    return table;
  }
  if (absent.length === 0) return table;
  logger.warn(
    `[capability-compose] report gate: ${absent.length} module entr${absent.length === 1 ? "y" : "ies"} absent, dropped from MODULE_TABLE: ${absent.map((m) => m.id).join(", ")}`,
  );
  return table.filter((m) => existsSync(m.absolute));
}

/** The `DistributionContract` the virtual module hands the runtime. */
function buildContract(settings, inventory, sets, table, workerVariants, base) {
  const moduleIds = table.map((m) => m.id).sort();
  return {
    distributionId: distributionId({
      mode: settings.mode,
      moduleIds,
      profileName: settings.profile.name,
      version: readVersion(settings.appRoot),
    }),
    mode: settings.mode,
    capabilityIds: [...sets.distributed].sort(),
    moduleIds,
    workerVariants: contractWorkerVariants(
      sets.distributed,
      inventory.catalog,
      workerVariants,
    ),
    basePath: base ?? "/",
  };
}

export async function composeState(options, userConfig, command = "build") {
  const settings = resolveSettings(options, command);
  const logger = options.logger ?? console;
  const inventory =
    options.inventory ??
    (await (options.loadInventory ?? loadInventory)(settings.appRoot, {
      alias: userConfig?.resolve?.alias,
      lenient: settings.gate === "report",
      logger,
    }));
  const sets = distributedCapabilities(
    inventory.catalog,
    settings.profile,
    settings.mode,
  );
  const diagnostics = [];
  const table = resolveModuleTable(
    inventory,
    sets,
    settings,
    logger,
    diagnostics,
  );
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
      `capability inventory rejects profile "${settings.profile.name}"`,
      diagnostics,
    );
  const workerVariants = inventory.workerVariants ?? undefined;
  assertWorkerVariantsCover(
    inventory.catalog,
    sets.distributed,
    workerVariants,
  );
  const rules = inventory.classification;
  return {
    ...settings,
    inventory,
    sets,
    isExcluded: (capability) =>
      capability !== null &&
      sets.all.has(capability) &&
      !sets.distributed.has(capability),
    table,
    htmlEntries,
    publicFiles,
    contract: buildContract(
      settings,
      inventory,
      sets,
      table,
      workerVariants,
      userConfig?.base,
    ),
    classify: (id) =>
      classifyModule(id, rules, { repoRoot: settings.repoRoot }),
    workers: workerVariantsFor(
      sets.distributed,
      inventory.catalog,
      workerVariants,
    ),
  };
}
