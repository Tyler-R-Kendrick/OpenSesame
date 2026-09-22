/**
 * The ownership-map and worker-variant projections the build plugin hands to
 * the virtual modules. Pure: no Vite, no filesystem. Profile reading and the
 * profile → distributed-capability decision live in `capability-profile.mjs`
 * and are re-exported here so one import serves the plugin.
 */
import {
  InvalidProfileError,
  asArray,
  catalogEntries,
} from "./capability-profile.mjs";

export {
  BUILD_MODES,
  IMPLICIT_PROFILE,
  InvalidProfileError,
  distributedCapabilities,
  distributionId,
  loadProfile,
  resolveBuildEnvironment,
} from "./capability-profile.mjs";

/** Service-worker variants a build can emit (ownership.md §4.7). */
export const WORKER_VARIANTS = Object.freeze([
  Object.freeze({
    id: "core-only",
    scriptPath: "sw.js",
    satisfies: Object.freeze([]),
    capability: null,
  }),
  Object.freeze({
    id: "push",
    scriptPath: "sw-push.js",
    satisfies: Object.freeze(["push"]),
    capability: "notifications.web-push",
  }),
]);

/**
 * Normalize S02's ownership exports into one record per module:
 * `{ id, capability, unit, entry }`, where `entry` is app-root-relative or
 * null (worker units). Accepts `Record<ModuleId, string | { capability?,
 * entry? | path? | file? }>` or an array of records with `id`/`moduleId`.
 */
export function normalizeModuleOwnership(ownership, catalog) {
  const records = [];
  const push = (id, value) => {
    if (typeof id !== "string" || !id.includes("/")) return;
    const [capability, unit] = [
      id.slice(0, id.indexOf("/")),
      id.slice(id.indexOf("/") + 1),
    ];
    const object = typeof value === "string" ? { entry: value } : (value ?? {});
    const declared = object.entry ?? object.path ?? object.file ?? null;
    // Only document-environment units are page-loadable; a worker unit is
    // satisfied by a worker variant and never enters the MODULE_TABLE.
    const pageLoadable =
      unit !== "worker" &&
      (!Array.isArray(object.environments) ||
        object.environments.includes("document"));
    const entry = declared ?? `src/modules/${capability}/${unit}.ts`;
    records.push({
      id,
      capability: object.capability ?? capability,
      unit,
      entry: pageLoadable ? entry : null,
      source: declared,
    });
  };
  if (Array.isArray(ownership)) {
    for (const record of ownership)
      push(record?.id ?? record?.moduleId, record);
  } else if (ownership && typeof ownership === "object") {
    for (const [id, value] of Object.entries(ownership)) push(id, value);
  }
  // Modules the catalog declares but the ownership map omits still count.
  const known = new Set(records.map((r) => r.id));
  for (const descriptor of catalogEntries(catalog).values()) {
    for (const id of asArray(descriptor.moduleIds)) {
      if (!known.has(id)) {
        push(id, { capability: descriptor.id });
        known.add(id);
      }
    }
  }
  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One `{ path, capability }` record from an array entry, or null. */
function fileRecordFromArrayEntry(record) {
  const path = record?.path ?? record?.file ?? record?.id;
  if (typeof path !== "string") return null;
  return { path, capability: record.capability ?? null };
}

/** `Record<path, CapabilityId | { capability }>` or array → `{ path, capability }[]`. */
export function normalizeFileOwnership(ownership) {
  const out = [];
  if (Array.isArray(ownership)) {
    for (const record of ownership) {
      const normalized = fileRecordFromArrayEntry(record);
      if (normalized) out.push(normalized);
    }
  } else if (ownership && typeof ownership === "object") {
    for (const [path, value] of Object.entries(ownership)) {
      out.push({
        path,
        capability:
          typeof value === "string" ? value : (value?.capability ?? null),
      });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Attach the owning capability to each variant: the catalogued capability
 * whose `workerGraphConstraint` the variant satisfies (null for core-only).
 * `variants` defaults to `WORKER_VARIANTS`; S02 may export its own list.
 */
export function ownedWorkerVariants(catalog, variants = WORKER_VARIANTS) {
  const descriptors = [...catalogEntries(catalog).values()];
  return variants.map((variant) => {
    if (variant.capability !== undefined) return variant;
    const owner = descriptors.find(
      (d) =>
        d.workerGraphConstraint &&
        asArray(variant.satisfies).includes(d.workerGraphConstraint),
    );
    return { ...variant, capability: owner?.id ?? null };
  });
}

/** `static-auth/**` → `static-auth` (a directory); other paths unchanged. */
export function publicPathTarget(path) {
  return path.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
}

export function workerVariantsFor(
  distributed,
  catalog = FALLBACK_EMPTY_CATALOG,
  variants = WORKER_VARIANTS,
) {
  return ownedWorkerVariants(catalog, variants).filter(
    (variant) =>
      variant.capability === null || distributed.has(variant.capability),
  );
}

const FALLBACK_EMPTY_CATALOG = Object.freeze({ capabilities: [] });

/** The `DistributionContract.workerVariants` projection (no `capability`). */
export function contractWorkerVariants(distributed, catalog, variants) {
  return workerVariantsFor(distributed, catalog, variants).map(
    ({ id, scriptPath, satisfies }) => ({
      id,
      scriptPath,
      satisfies: [...satisfies],
    }),
  );
}

/** Throws when a distributed capability needs a worker graph no variant provides. */
export function assertWorkerVariantsCover(catalog, distributed, variants) {
  const workerVariants = workerVariantsFor(distributed, catalog, variants);
  const missing = [];
  for (const descriptor of catalogEntries(catalog).values()) {
    if (!distributed.has(descriptor.id)) continue;
    const constraint = descriptor.workerGraphConstraint;
    if (constraint === null || constraint === undefined) continue;
    if (!workerVariants.some((v) => asArray(v.satisfies).includes(constraint)))
      missing.push(`"${descriptor.id}" needs worker graph "${constraint}"`);
  }
  if (missing.length > 0)
    throw new InvalidProfileError("no worker variant satisfies", missing);
}
