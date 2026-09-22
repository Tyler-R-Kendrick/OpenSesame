/**
 * Catalog construction and validation.
 *
 * `buildCatalog` stamps every descriptor with its exposure digest;
 * `validateCatalog` checks the whole authored corpus as one unit — ids,
 * bounds, graph well-formedness, tier rules, module ownership, and that no
 * stored digest disagrees with the declared exposure.
 */
import { exposureDigest } from "./canonical.js";
import {
  type Diagnostic,
  type ValidationResult,
  diagnostic,
  pushDiagnostic,
  validationOf,
} from "./diagnostics.js";
import { compareIds, isCapabilityId, isModuleId, isUnitName } from "./ids.js";
import type {
  CapabilityCatalog,
  CapabilityDescriptor,
  CapabilityId,
} from "./types.js";

export const MAX_CATALOG_CAPABILITIES = 256;
export const MAX_DEPENDENCY_DEPTH = 16;
export const MAX_TITLE_LENGTH = 80;
export const MAX_SUMMARY_LENGTH = 400;
const MAX_PURPOSE_LENGTH = 120;

const ENVIRONMENTS = new Set([
  "document",
  "dedicated-worker",
  "shared-worker",
  "service-worker",
]);
const EGRESS_CLASSES = new Set([
  "application-assets",
  "external-service",
  "peer-or-local-network",
  "user-mediated-navigation",
]);
const KEY_ACCESS = new Set([
  "none",
  "item-plaintext",
  "protector-wrap",
  "provider-bearer",
]);

export type CatalogIndex = ReadonlyMap<CapabilityId, CapabilityDescriptor>;

export function indexCatalog(catalog: CapabilityCatalog): CatalogIndex {
  return new Map(catalog.capabilities.map((d) => [d.id, d]));
}

export function buildCatalog(
  descriptors: readonly Omit<CapabilityDescriptor, "exposureDigest">[],
  catalogVersion: number,
): CapabilityCatalog {
  return {
    catalogVersion,
    capabilities: descriptors.map((d) => ({
      ...d,
      exposureDigest: exposureDigest(d),
    })),
  };
}

/** Outgoing edges that shape the closure: hard dependencies and every alternative. */
function graphEdges(d: CapabilityDescriptor): CapabilityId[] {
  const out = new Set<CapabilityId>(d.dependencies);
  for (const slot of d.alternatives) for (const id of slot.oneOf) out.add(id);
  return [...out].sort(compareIds);
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function checkText(
  d: CapabilityDescriptor,
  path: string,
  diags: Diagnostic[],
): void {
  if (d.title.length === 0 || d.title.length > MAX_TITLE_LENGTH) {
    pushDiagnostic(
      diags,
      diagnostic(
        "INVALID_LENGTH",
        `${path}.title`,
        `title must be 1–${MAX_TITLE_LENGTH} characters`,
      ),
    );
  }
  if (d.summary.length > MAX_SUMMARY_LENGTH) {
    pushDiagnostic(
      diags,
      diagnostic(
        "INVALID_LENGTH",
        `${path}.summary`,
        `summary must be at most ${MAX_SUMMARY_LENGTH} characters`,
      ),
    );
  }
  if (!Number.isInteger(d.descriptorVersion) || d.descriptorVersion < 1) {
    pushDiagnostic(
      diags,
      diagnostic(
        "INVALID_VALUE",
        `${path}.descriptorVersion`,
        "descriptorVersion must be a positive integer",
      ),
    );
  }
  if (d.tier !== "core" && d.tier !== "optional") {
    pushDiagnostic(
      diags,
      diagnostic(
        "INVALID_VALUE",
        `${path}.tier`,
        "tier must be core or optional",
      ),
    );
  }
  if (!KEY_ACCESS.has(d.keyAccess)) {
    pushDiagnostic(
      diags,
      diagnostic(
        "INVALID_VALUE",
        `${path}.keyAccess`,
        "unknown key access class",
      ),
    );
  }
}

function checkEnvironments(
  d: CapabilityDescriptor,
  path: string,
  diags: Diagnostic[],
): void {
  if (d.environments.length === 0) {
    pushDiagnostic(
      diags,
      diagnostic(
        "INVALID_VALUE",
        `${path}.environments`,
        "a capability must name at least one environment",
      ),
    );
  }
  if (
    hasDuplicates(d.environments) ||
    d.environments.some((e) => !ENVIRONMENTS.has(e))
  ) {
    pushDiagnostic(
      diags,
      diagnostic(
        "INVALID_VALUE",
        `${path}.environments`,
        "environments must be unique and known",
      ),
    );
  }
  if (
    d.workerGraphConstraint !== null &&
    !isUnitName(d.workerGraphConstraint)
  ) {
    pushDiagnostic(
      diags,
      diagnostic(
        "INVALID_ID",
        `${path}.workerGraphConstraint`,
        "worker-graph constraint is malformed",
      ),
    );
  }
  d.egress.forEach((e, index) => {
    if (
      !EGRESS_CLASSES.has(e.class) ||
      e.purpose.length === 0 ||
      e.purpose.length > MAX_PURPOSE_LENGTH
    ) {
      pushDiagnostic(
        diags,
        diagnostic(
          "INVALID_VALUE",
          `${path}.egress[${index}]`,
          "egress declaration is malformed",
        ),
      );
    }
  });
  if (hasDuplicates(d.browserPermissions)) {
    pushDiagnostic(
      diags,
      diagnostic(
        "DUPLICATE_ID",
        `${path}.browserPermissions`,
        "browser permissions repeat",
      ),
    );
  }
  if (hasDuplicates(d.operationIds) || hasDuplicates(d.itemKinds)) {
    pushDiagnostic(
      diags,
      diagnostic(
        "DUPLICATE_ID",
        `${path}.operationIds`,
        "operation ids or item kinds repeat",
      ),
    );
  }
}

function checkModules(
  d: CapabilityDescriptor,
  path: string,
  diags: Diagnostic[],
): void {
  if (hasDuplicates(d.moduleIds)) {
    pushDiagnostic(
      diags,
      diagnostic("DUPLICATE_ID", `${path}.moduleIds`, "module ids repeat"),
    );
  }
  d.moduleIds.forEach((moduleId, index) => {
    if (!isModuleId(moduleId) || !moduleId.startsWith(`${d.id}/`)) {
      pushDiagnostic(
        diags,
        diagnostic(
          "INVALID_ID",
          `${path}.moduleIds[${index}]`,
          `module \`${moduleId}\` must be \`${d.id}/<unit>\``,
        ),
      );
    }
  });
}

function checkReferences(
  d: CapabilityDescriptor,
  path: string,
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
  diags: Diagnostic[],
): void {
  const refCheck = (id: CapabilityId, refPath: string): void => {
    const target = index.get(id);
    if (target === undefined) {
      pushDiagnostic(
        diags,
        diagnostic(
          "UNKNOWN_CAPABILITY",
          refPath,
          `\`${id}\` is not in the catalog`,
        ),
      );
      return;
    }
    if (id === d.id) {
      pushDiagnostic(
        diags,
        diagnostic("DEPENDENCY_CYCLE", refPath, `\`${id}\` refers to itself`),
      );
    }
    if (d.tier === "core" && target.tier === "optional") {
      pushDiagnostic(
        diags,
        diagnostic(
          "CORE_DEPENDS_ON_OPTIONAL",
          refPath,
          `core \`${d.id}\` may not depend on optional \`${id}\``,
        ),
      );
    }
  };
  if (hasDuplicates(d.dependencies)) {
    pushDiagnostic(
      diags,
      diagnostic("DUPLICATE_ID", `${path}.dependencies`, "dependencies repeat"),
    );
  }
  d.dependencies.forEach((id, i) => refCheck(id, `${path}.dependencies[${i}]`));
  const slots = new Set<string>();
  d.alternatives.forEach((slot, i) => {
    const slotPath = `${path}.alternatives[${i}]`;
    if (!isUnitName(slot.slot) || slots.has(slot.slot)) {
      pushDiagnostic(
        diags,
        diagnostic(
          "INVALID_ID",
          `${slotPath}.slot`,
          `slot \`${slot.slot}\` must be well-formed and unique`,
        ),
      );
    }
    slots.add(slot.slot);
    if (slot.oneOf.length === 0 || hasDuplicates(slot.oneOf)) {
      pushDiagnostic(
        diags,
        diagnostic(
          "INVALID_VALUE",
          `${slotPath}.oneOf`,
          "a slot needs at least one distinct option",
        ),
      );
    }
    slot.oneOf.forEach((id, j) => refCheck(id, `${slotPath}.oneOf[${j}]`));
  });
}

/**
 * Longest-path depth over the dependency graph; a cycle is reported once at
 * the lexicographically smallest capability on it. Iterative and bounded by
 * the catalog size.
 */
function checkGraph(
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
  diags: Diagnostic[],
): void {
  const depth = new Map<CapabilityId, number>();
  const onStack = new Set<CapabilityId>();
  const cyclic = new Set<CapabilityId>();
  const visit = (id: CapabilityId): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (onStack.has(id)) {
      cyclic.add(id);
      return 0;
    }
    const d = index.get(id);
    if (d === undefined) return 0;
    onStack.add(id);
    let deepest = 0;
    for (const edge of graphEdges(d))
      deepest = Math.max(deepest, visit(edge) + 1);
    onStack.delete(id);
    depth.set(id, deepest);
    return deepest;
  };
  for (const id of [...index.keys()].sort(compareIds)) {
    const d = visit(id);
    if (d > MAX_DEPENDENCY_DEPTH) {
      pushDiagnostic(
        diags,
        diagnostic(
          "DEPENDENCY_DEPTH",
          `capabilities.${id}`,
          `dependency depth ${d} exceeds ${MAX_DEPENDENCY_DEPTH}`,
        ),
      );
    }
  }
  for (const id of [...cyclic].sort(compareIds)) {
    pushDiagnostic(
      diags,
      diagnostic(
        "DEPENDENCY_CYCLE",
        `capabilities.${id}`,
        `\`${id}\` is on a dependency cycle`,
      ),
    );
  }
}

export function validateCatalog(c: CapabilityCatalog): ValidationResult {
  const diags: Diagnostic[] = [];
  if (!Number.isInteger(c.catalogVersion) || c.catalogVersion < 1) {
    pushDiagnostic(
      diags,
      diagnostic(
        "INVALID_VALUE",
        "catalogVersion",
        "catalogVersion must be a positive integer",
      ),
    );
  }
  if (c.capabilities.length > MAX_CATALOG_CAPABILITIES) {
    pushDiagnostic(
      diags,
      diagnostic(
        "CATALOG_TOO_LARGE",
        "capabilities",
        `more than ${MAX_CATALOG_CAPABILITIES} capabilities`,
      ),
    );
    return validationOf(diags);
  }
  const index = new Map<CapabilityId, CapabilityDescriptor>();
  c.capabilities.forEach((d, i) => {
    const path = `capabilities[${i}]`;
    if (!isCapabilityId(d.id)) {
      pushDiagnostic(
        diags,
        diagnostic(
          "INVALID_ID",
          `${path}.id`,
          `\`${d.id}\` is not a capability id`,
        ),
      );
    }
    if (index.has(d.id)) {
      pushDiagnostic(
        diags,
        diagnostic(
          "DUPLICATE_ID",
          `${path}.id`,
          `\`${d.id}\` is declared twice`,
        ),
      );
    }
    index.set(d.id, d);
  });
  c.capabilities.forEach((d, i) => {
    const path = `capabilities[${i}]`;
    checkText(d, path, diags);
    checkEnvironments(d, path, diags);
    checkModules(d, path, diags);
    checkReferences(d, path, index, diags);
    const { exposureDigest: stored, ...declared } = d;
    if (exposureDigest(declared) !== stored) {
      pushDiagnostic(
        diags,
        diagnostic(
          "INVALID_DIGEST",
          `${path}.exposureDigest`,
          `\`${d.id}\` exposure digest does not match its declaration`,
        ),
      );
    }
  });
  if (diags.length === 0) checkGraph(index, diags);
  return validationOf(diags);
}
