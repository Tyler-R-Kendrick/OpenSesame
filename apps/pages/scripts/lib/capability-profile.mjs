/**
 * Build-time profile handling: the `OPENSESAME_*` variables, reading a
 * profile JSON, and validating it against S02's catalog to decide which
 * capabilities a build must carry. Pure apart from `loadProfile`'s read.
 *
 * The runtime authority on what a person may *use* is `resolveComposition`
 * (S01). A build decides what is *present*: in `selective` mode every
 * catalogued module ships and the runtime narrows; in `hardened` mode only
 * the profile's selected closure (plus core) is emitted, so an excluded
 * capability is physically absent (BUILD-04). Consent is a runtime fact and
 * does not shrink a distribution.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

export const BUILD_MODES = Object.freeze(["selective", "hardened"]);

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

export const asArray = (value) => (Array.isArray(value) ? value : []);

/** Accept the catalog as `{ capabilities }` or a bare descriptor array. */
export function catalogEntries(catalog) {
  const list = Array.isArray(catalog)
    ? catalog
    : asArray(catalog?.capabilities);
  const byId = new Map();
  for (const descriptor of list) {
    if (!descriptor || typeof descriptor.id !== "string") continue;
    byId.set(descriptor.id, descriptor);
  }
  return byId;
}

function requireKnown(byId, ids, where, diagnostics) {
  for (const id of ids) {
    if (!byId.has(id))
      diagnostics.push(`${where} names unknown capability "${id}"`);
  }
}

/** The policy/selection sets a profile carries, as plain sets. */
function profileSets(profile) {
  const policy = profile.instancePolicy;
  const selection = profile.installationSelection;
  return {
    policy,
    required: new Set(asArray(policy?.capabilities?.required)),
    allowed: new Set(asArray(policy?.capabilities?.optional)),
    prohibited: new Set(asArray(policy?.capabilities?.prohibited)),
    acceptedRequired: new Set(asArray(selection?.acceptedRequired)),
    selectedOptional: new Set(asArray(selection?.selectedOptional)),
    chosen: selection?.chosenAlternatives ?? {},
  };
}

/** Every set names a known capability, and the policy does not contradict itself. */
function validateSets(byId, optional, sets, diagnostics) {
  const named = [
    [sets.required, "instancePolicy.capabilities.required"],
    [sets.allowed, "instancePolicy.capabilities.optional"],
    [sets.prohibited, "instancePolicy.capabilities.prohibited"],
    [sets.acceptedRequired, "installationSelection.acceptedRequired"],
    [sets.selectedOptional, "installationSelection.selectedOptional"],
    [Object.values(sets.chosen), "installationSelection.chosenAlternatives"],
  ];
  for (const [ids, where] of named) requireKnown(byId, ids, where, diagnostics);
  for (const id of [...sets.required, ...sets.allowed, ...sets.prohibited]) {
    if (byId.has(id) && !optional.has(id))
      diagnostics.push(
        `core capability "${id}" may not appear in a policy set`,
      );
  }
  for (const id of sets.required) {
    if (sets.prohibited.has(id))
      diagnostics.push(`"${id}" is both required and prohibited`);
  }
  const fallback = sets.policy?.capabilities?.default;
  if (sets.policy && fallback !== undefined && fallback !== "deny")
    diagnostics.push(`instancePolicy.capabilities.default must be "deny"`);
  for (const id of sets.acceptedRequired) {
    if (byId.has(id) && !sets.required.has(id))
      diagnostics.push(
        `acceptedRequired names "${id}", which the policy does not require`,
      );
  }
}

/**
 * Acceptance and selection are runtime facts the resolver answers with a
 * reason code (REQUIRED_NOT_ACCEPTED, PROHIBITED_BY_INSTANCE, ...). A build
 * ships what the policy lets this installation reach: every required root (an
 * artifact must carry them for the acceptance to be possible) plus the
 * permitted selected optionals. A selected root the policy refuses is dropped
 * and noted, never a build error; the policy's own contradictions are.
 */
function resolveRoots(byId, sets, permitted, notes) {
  for (const id of sets.required) {
    if (!sets.acceptedRequired.has(id))
      notes.push(
        `required "${id}" is not yet accepted; distributed regardless`,
      );
  }
  const roots = [];
  for (const id of [...sets.required, ...sets.selectedOptional]) {
    if (!byId.has(id)) continue;
    if (permitted(id)) roots.push(id);
    else
      notes.push(
        `selected "${id}" is not permitted by the policy; not distributed`,
      );
  }
  return roots;
}

function closeOverDependencies(byId, descriptor, id, permitted, diagnostics) {
  const next = [];
  for (const dependency of asArray(descriptor?.dependencies)) {
    if (!byId.has(dependency)) {
      diagnostics.push(`"${id}" depends on unknown capability "${dependency}"`);
      continue;
    }
    if (byId.get(dependency).tier === "core") continue;
    if (!permitted(dependency))
      diagnostics.push(
        `"${id}" depends on "${dependency}", which is not permitted`,
      );
    next.push(dependency);
  }
  return next;
}

function closeOverAlternatives(descriptor, id, chosen, permitted, diagnostics) {
  const next = [];
  for (const slot of asArray(descriptor?.alternatives)) {
    const pick = chosen[slot.slot];
    if (pick === undefined) {
      diagnostics.push(
        `"${id}" needs a choice for alternatives slot "${slot.slot}"`,
      );
      continue;
    }
    if (!asArray(slot.oneOf).includes(pick)) {
      diagnostics.push(
        `slot "${slot.slot}" chose "${pick}", not one of ${JSON.stringify(slot.oneOf)}`,
      );
      continue;
    }
    if (!permitted(pick))
      diagnostics.push(
        `alternative "${pick}" for slot "${slot.slot}" is not permitted`,
      );
    next.push(pick);
  }
  return next;
}

/** Roots + hard dependencies + chosen alternatives, each permitted. */
function closure(byId, roots, chosen, permitted, diagnostics) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const descriptor = byId.get(id);
    queue.push(
      ...closeOverDependencies(byId, descriptor, id, permitted, diagnostics),
      ...closeOverAlternatives(descriptor, id, chosen, permitted, diagnostics),
    );
  }
  return seen;
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
  const notes = [];
  const core = [...byId.values()]
    .filter((d) => d.tier === "core")
    .map((d) => d.id);
  const optional = new Set(
    [...byId.values()].filter((d) => d.tier !== "core").map((d) => d.id),
  );
  const sets = profileSets(profile);
  validateSets(byId, optional, sets, diagnostics);

  const permitted = (id) =>
    optional.has(id) &&
    !sets.prohibited.has(id) &&
    (sets.policy === null ||
      sets.policy === undefined ||
      sets.required.has(id) ||
      sets.allowed.has(id));

  const roots = resolveRoots(byId, sets, permitted, notes);
  const reached = closure(byId, roots, sets.chosen, permitted, diagnostics);
  if (diagnostics.length > 0) {
    throw new InvalidProfileError(
      `capability profile "${profile.name}" is invalid`,
      diagnostics,
    );
  }
  return {
    core: new Set(core),
    closure: reached,
    distributed:
      mode === "hardened"
        ? new Set([...core, ...reached])
        : new Set(byId.keys()),
    all: new Set(byId.keys()),
    notes,
  };
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
