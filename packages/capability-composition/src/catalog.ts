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
  MAX_DEPENDENCY_DEPTH,
  checkGraph,
  checkReferences,
  hasDuplicates,
} from "./catalog-graph.js";
import {
  type Diagnostic,
  type ValidationResult,
  diagnostic,
  pushDiagnostic,
  validationOf,
} from "./diagnostics.js";
import { isCapabilityId, isModuleId, isUnitName } from "./ids.js";
import type {
  CapabilityCatalog,
  CapabilityDescriptor,
  CapabilityId,
} from "./types.js";

export const MAX_CATALOG_CAPABILITIES = 256;
export const MAX_TITLE_LENGTH = 80;
export { MAX_DEPENDENCY_DEPTH };
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
