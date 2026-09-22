/**
 * Profile → distributed-capability set, and the shapes the build plugin
 * hands to the virtual modules. Pure: no Vite, no filesystem beyond
 * `loadProfile`.
 *
 * The runtime authority on what a person may *use* is
 * `resolveComposition` (S01). A build decides what is *present*: in
 * `selective` mode every catalogued module ships and the runtime narrows; in
 * `hardened` mode only the profile's selected closure (plus core) is emitted,
 * so an excluded capability is physically absent (BUILD-04). Consent is a
 * runtime fact and does not shrink a distribution.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

export const BUILD_MODES = Object.freeze(["selective", "hardened"]);

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

export class InvalidProfileError extends Error {
  constructor(message, diagnostics = []) {
    super(
      diagnostics.length > 0
        ? `${message}\n  - ${diagnostics.join("\n  - ")}`
        : message,
    );
    this.name = "InvalidProfileError";
    this.diagnostics = diagnostics;
  }
}

/** Reads `OPENSESAME_*` build variables; the one place their defaults live. */
export function resolveBuildEnvironment(env = process.env) {
  const mode = env.OPENSESAME_BUILD_MODE || "selective";
  if (!BUILD_MODES.includes(mode)) {
    throw new InvalidProfileError(
      `OPENSESAME_BUILD_MODE must be one of ${BUILD_MODES.join("|")}, got "${mode}"`,
    );
  }
  const gate = env.OPENSESAME_GRAPH_GATE || "enforce";
  if (gate !== "enforce" && gate !== "report") {
    throw new InvalidProfileError(
      `OPENSESAME_GRAPH_GATE must be enforce|report, got "${gate}"`,
    );
  }
  return { mode, gate, profilePath: env.OPENSESAME_CAPABILITY_PROFILE || null };
}

/** The implicit profile when none is named: everything present, selective. */
export const IMPLICIT_PROFILE = Object.freeze({
  name: "rich-explicit",
  path: null,
  instancePolicy: null,
  installationSelection: null,
  expectInvalid: false,
});

export function loadProfile(path, cwd = process.cwd()) {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new InvalidProfileError(
      `capability profile not readable: ${absolute} (${error.code ?? error.message})`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InvalidProfileError(
      `capability profile is not JSON: ${absolute}: ${error.message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidProfileError(
      `capability profile must be an object: ${absolute}`,
    );
  }
  return {
    name:
      typeof parsed.name === "string" && parsed.name
        ? parsed.name
        : basename(absolute).replace(/\.json$/, ""),
    path: absolute,
    instancePolicy: parsed.instancePolicy ?? null,
    installationSelection: parsed.installationSelection ?? null,
    expectInvalid: parsed.expectInvalid === true,
  };
}

const asArray = (value) => (Array.isArray(value) ? value : []);

/** Accept the catalog as `{ capabilities }` or a bare descriptor array. */
function catalogEntries(catalog) {
  const list = Array.isArray(catalog) ? catalog : asArray(catalog?.capabilities);
  const byId = new Map();
  for (const descriptor of list) {
    if (!descriptor || typeof descriptor.id !== "string") continue;
    byId.set(descriptor.id, descriptor);
  }
  return byId;
}

function requireKnown(byId, ids, where, diagnostics) {
  for (const id of ids) {
    if (!byId.has(id)) diagnostics.push(`${where} names unknown capability "${id}"`);
  }
}

/**
 * Validate a profile against the catalog and return the capability ids whose
 * implementation the build must carry. Throws `InvalidProfileError` on a
 * parse error, unknown capability, or contradictory policy/selection
 * (BUILD-05), in either mode.
 */
export function distributedCapabilities(catalog, profile, mode) {
  const byId = catalogEntries(catalog);
  const diagnostics = [];
  const core = [...byId.values()]
    .filter((d) => d.tier === "core")
    .map((d) => d.id);
  const optional = new Set(
    [...byId.values()].filter((d) => d.tier !== "core").map((d) => d.id),
  );
  const policy = profile.instancePolicy;
  const selection = profile.installationSelection;

  const required = new Set(asArray(policy?.capabilities?.required));
  const allowed = new Set(asArray(policy?.capabilities?.optional));
  const prohibited = new Set(asArray(policy?.capabilities?.prohibited));
  const acceptedRequired = new Set(asArray(selection?.acceptedRequired));
  const selectedOptional = new Set(asArray(selection?.selectedOptional));
  const chosen = selection?.chosenAlternatives ?? {};

  requireKnown(byId, required, "instancePolicy.capabilities.required", diagnostics);
  requireKnown(byId, allowed, "instancePolicy.capabilities.optional", diagnostics);
  requireKnown(byId, prohibited, "instancePolicy.capabilities.prohibited", diagnostics);
  requireKnown(byId, acceptedRequired, "installationSelection.acceptedRequired", diagnostics);
  requireKnown(byId, selectedOptional, "installationSelection.selectedOptional", diagnostics);
  requireKnown(byId, Object.values(chosen), "installationSelection.chosenAlternatives", diagnostics);
  for (const id of [...required, ...allowed, ...prohibited]) {
    if (byId.has(id) && !optional.has(id))
      diagnostics.push(`core capability "${id}" may not appear in a policy set`);
  }
  for (const id of required) {
    if (prohibited.has(id))
      diagnostics.push(`"${id}" is both required and prohibited`);
  }
  if (policy && policy.capabilities?.default !== undefined && policy.capabilities.default !== "deny") {
    diagnostics.push(`instancePolicy.capabilities.default must be "deny"`);
  }
  const permitted = (id) =>
    optional.has(id) &&
    !prohibited.has(id) &&
    (policy === null || policy === undefined || required.has(id) || allowed.has(id));

  // Acceptance and selection are runtime facts the resolver answers with a
  // reason code (REQUIRED_NOT_ACCEPTED, PROHIBITED_BY_INSTANCE, ...). A build
  // ships what the policy lets this installation reach: every required root
  // (an artifact must carry them for the acceptance to be possible) plus the
  // permitted selected optionals. A selected root the policy refuses is
  // dropped and noted, never a build error; the policy's own contradictions
  // (above) are.
  const notes = [];
  for (const id of required) {
    if (!acceptedRequired.has(id)) notes.push(`required "${id}" is not yet accepted; distributed regardless`);
  }
  for (const id of acceptedRequired) {
    if (byId.has(id) && !required.has(id))
      diagnostics.push(`acceptedRequired names "${id}", which the policy does not require`);
  }
  const roots = [];
  for (const id of [...required, ...selectedOptional]) {
    if (!byId.has(id)) continue;
    if (permitted(id)) roots.push(id);
    else notes.push(`selected "${id}" is not permitted by the policy; not distributed`);
  }

  // Closure: roots + hard dependencies + chosen alternatives, each permitted.
  const closure = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift();
    if (closure.has(id)) continue;
    closure.add(id);
    const descriptor = byId.get(id);
    for (const dependency of asArray(descriptor?.dependencies)) {
      if (!byId.has(dependency)) {
        diagnostics.push(`"${id}" depends on unknown capability "${dependency}"`);
        continue;
      }
      if (byId.get(dependency).tier === "core") continue;
      if (!permitted(dependency))
        diagnostics.push(`"${id}" depends on "${dependency}", which is not permitted`);
      queue.push(dependency);
    }
    for (const slot of asArray(descriptor?.alternatives)) {
      const pick = chosen[slot.slot];
      if (pick === undefined) {
        diagnostics.push(`"${id}" needs a choice for alternatives slot "${slot.slot}"`);
        continue;
      }
      if (!asArray(slot.oneOf).includes(pick)) {
        diagnostics.push(`slot "${slot.slot}" chose "${pick}", not one of ${JSON.stringify(slot.oneOf)}`);
        continue;
      }
      if (!permitted(pick))
        diagnostics.push(`alternative "${pick}" for slot "${slot.slot}" is not permitted`);
      queue.push(pick);
    }
  }
  if (diagnostics.length > 0) {
    throw new InvalidProfileError(
      `capability profile "${profile.name}" is invalid`,
      diagnostics,
    );
  }
  const distributed =
    mode === "hardened" ? new Set([...core, ...closure]) : new Set(byId.keys());
  return {
    core: new Set(core),
    closure,
    distributed,
    all: new Set(byId.keys()),
    notes,
  };
}

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
    const [capability, unit] = [id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1)];
    const object = typeof value === "string" ? { entry: value } : (value ?? {});
    const declared = object.entry ?? object.path ?? object.file ?? null;
    // Only document-environment units are page-loadable; a worker unit is
    // satisfied by a worker variant and never enters the MODULE_TABLE.
    const pageLoadable =
      unit !== "worker" &&
      (!Array.isArray(object.environments) || object.environments.includes("document"));
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
    for (const record of ownership) push(record?.id ?? record?.moduleId, record);
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

/** `Record<path, CapabilityId | { capability }>` or array → `{ path, capability }[]`. */
export function normalizeFileOwnership(ownership) {
  const out = [];
  if (Array.isArray(ownership)) {
    for (const record of ownership) {
      const path = record?.path ?? record?.file ?? record?.id;
      if (typeof path === "string") out.push({ path, capability: record.capability ?? null });
    }
  } else if (ownership && typeof ownership === "object") {
    for (const [path, value] of Object.entries(ownership)) {
      out.push({
        path,
        capability: typeof value === "string" ? value : (value?.capability ?? null),
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
      (d) => d.workerGraphConstraint && asArray(variant.satisfies).includes(d.workerGraphConstraint),
    );
    return { ...variant, capability: owner?.id ?? null };
  });
}

/** `static-auth/**` → `static-auth` (a directory); other paths unchanged. */
export function publicPathTarget(path) {
  return path.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
}

export function workerVariantsFor(distributed, catalog = FALLBACK_EMPTY_CATALOG, variants = WORKER_VARIANTS) {
  return ownedWorkerVariants(catalog, variants).filter(
    (variant) => variant.capability === null || distributed.has(variant.capability),
  );
}

const FALLBACK_EMPTY_CATALOG = Object.freeze({ capabilities: [] });

/** The `DistributionContract.workerVariants` projection (no `capability`). */
export function contractWorkerVariants(distributed, catalog, variants) {
  return workerVariantsFor(distributed, catalog, variants).map(({ id, scriptPath, satisfies }) => ({
    id,
    scriptPath,
    satisfies: [...satisfies],
  }));
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

export function distributionId({ mode, moduleIds, profileName, version }) {
  const hash = createHash("sha256");
  hash.update(mode);
  hash.update("\n");
  hash.update([...moduleIds].sort().join("\n"));
  hash.update("\n");
  hash.update(profileName);
  hash.update("\n");
  hash.update(version);
  return `dist:${hash.digest("hex")}`;
}
