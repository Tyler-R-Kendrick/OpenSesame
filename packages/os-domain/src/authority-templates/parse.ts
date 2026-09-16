/**
 * Schema validation for audience templates (ADR 0120).
 */

import {
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "../json.js";
import {
  AUDIENCE_TEMPLATE_IDS,
  type AudienceDefaults,
  type AudienceLimits,
  type AudienceTemplate,
  AudienceTemplateError,
  type AudienceTemplateId,
  type AudienceVocabulary,
  FORBIDDEN_TEMPLATE_KEYS,
  INHERITANCE_DEFAULTS,
  type InheritanceDefault,
  LIFETIME_KINDS,
  type LifetimeKindDefault,
  type MutableAudienceDefaults,
  type MutableAudienceLimits,
  SUPPORT_CLAIM_STATUSES,
  type SupportClaim,
  type SupportClaimStatus,
  UNWIRED_PORTAL_SURFACES,
  USAGE_ACCOUNTING_MODES,
  type UsageAccountingMode,
  includesId,
} from "./types.js";

function refuse(code: string, message: string): never {
  throw new AudienceTemplateError(code, message);
}

function isAudienceId(value: string): value is AudienceTemplateId {
  return includesId(AUDIENCE_TEMPLATE_IDS, value);
}

function isSupportStatus(value: string): value is SupportClaimStatus {
  return includesId(SUPPORT_CLAIM_STATUSES, value);
}

function isLifetimeKind(value: string): value is LifetimeKindDefault {
  return includesId(LIFETIME_KINDS, value);
}

function isInheritance(value: string): value is InheritanceDefault {
  return includesId(INHERITANCE_DEFAULTS, value);
}

function isUsageAccounting(value: string): value is UsageAccountingMode {
  return includesId(USAGE_ACCOUNTING_MODES, value);
}

function assertNoForbiddenKeys(value: JsonValue, path: string): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertNoForbiddenKeys(entry, `${path}[${index}]`);
    }
    return;
  }
  if (!isJsonObject(value)) return;
  for (const key of Object.keys(value)) {
    if (includesId(FORBIDDEN_TEMPLATE_KEYS, key)) {
      refuse(
        "forbidden_key",
        `${path}.${key} is engine logic, not template vocabulary`,
      );
    }
    const child = value[key];
    if (child === undefined) continue;
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

function readString(obj: JsonObject, key: string, path: string): string {
  const value = obj[key];
  if (!isString(value) || value.trim() === "") {
    refuse("schema", `${path}.${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalPositiveInt(
  obj: JsonObject,
  key: string,
  path: string,
): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!isNumber(value) || !Number.isInteger(value) || value <= 0) {
    refuse("schema", `${path}.${key} must be a positive integer`);
  }
  return value;
}

function readOptionalBoolean(
  obj: JsonObject,
  key: string,
  path: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!isBoolean(value)) {
    refuse("schema", `${path}.${key} must be a boolean`);
  }
  return value;
}

function readStringList(
  obj: JsonObject,
  key: string,
  path: string,
): readonly string[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.length === 0) {
    refuse("schema", `${path}.${key} must be a non-empty string array`);
  }
  return value.map((entry, index) => {
    if (!isString(entry) || entry.trim() === "") {
      refuse("schema", `${path}.${key}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

function parseSupportClaim(raw: JsonValue, path: string): SupportClaim {
  if (!isJsonObject(raw)) refuse("schema", `${path} must be an object`);
  const id = readString(raw, "id", path);
  const label = readString(raw, "label", path);
  const statusRaw = readString(raw, "status", path);
  if (!isSupportStatus(statusRaw)) {
    refuse(
      "honest_support",
      `${path}.status must be one of ${SUPPORT_CLAIM_STATUSES.join(", ")}`,
    );
  }
  const note = readString(raw, "note", path);
  if (
    includesId(UNWIRED_PORTAL_SURFACES, id) &&
    statusRaw === "local_defaults_only"
  ) {
    refuse(
      "honest_support",
      `${path}: ${id} cannot be local_defaults_only; mark unsupported or configuration_required`,
    );
  }
  return { id, label, status: statusRaw, note };
}

function parseVocabulary(raw: JsonValue, path: string): AudienceVocabulary {
  if (!isJsonObject(raw)) refuse("schema", `${path} must be an object`);
  const domain = readString(raw, "domain", path);
  const participant = readString(raw, "participant", path);
  const supervisor = raw.supervisor;
  if (supervisor === undefined) return { domain, participant };
  if (!isString(supervisor) || supervisor.trim() === "") {
    refuse("schema", `${path}.supervisor must be a non-empty string when set`);
  }
  return { domain, participant, supervisor };
}

function parseDefaults(raw: JsonValue, path: string): AudienceDefaults {
  if (!isJsonObject(raw)) refuse("schema", `${path} must be an object`);
  const lifetimeKindRaw = readString(raw, "lifetimeKind", path);
  if (!isLifetimeKind(lifetimeKindRaw)) {
    refuse("schema", `${path}.lifetimeKind must be permanent or temporary`);
  }
  const inheritanceRaw = readString(raw, "inheritance", path);
  if (!isInheritance(inheritanceRaw)) {
    refuse("schema", `${path}.inheritance must be inherit or isolated`);
  }
  const suggestedVerbs = readStringList(raw, "suggestedVerbs", path);
  const defaultLifetimeMs = readOptionalPositiveInt(
    raw,
    "defaultLifetimeMs",
    path,
  );
  const maxLifetimeMs = readOptionalPositiveInt(raw, "maxLifetimeMs", path);
  if (
    lifetimeKindRaw === "temporary" &&
    (defaultLifetimeMs === undefined || maxLifetimeMs === undefined)
  ) {
    refuse(
      "schema",
      `${path}: temporary templates need defaultLifetimeMs and maxLifetimeMs`,
    );
  }
  if (
    defaultLifetimeMs !== undefined &&
    maxLifetimeMs !== undefined &&
    defaultLifetimeMs > maxLifetimeMs
  ) {
    refuse("schema", `${path}: defaultLifetimeMs cannot exceed maxLifetimeMs`);
  }
  const usageRaw = raw.usageAccounting;
  let usageAccounting: UsageAccountingMode | undefined;
  if (usageRaw !== undefined) {
    if (!isString(usageRaw) || !isUsageAccounting(usageRaw)) {
      refuse(
        "schema",
        `${path}.usageAccounting must be per_device or wall_clock_union`,
      );
    }
    usageAccounting = usageRaw;
  }
  const defaults: MutableAudienceDefaults = {
    lifetimeKind: lifetimeKindRaw,
    inheritance: inheritanceRaw,
    suggestedVerbs,
  };
  if (defaultLifetimeMs !== undefined)
    defaults.defaultLifetimeMs = defaultLifetimeMs;
  if (maxLifetimeMs !== undefined) defaults.maxLifetimeMs = maxLifetimeMs;
  if (usageAccounting !== undefined) defaults.usageAccounting = usageAccounting;
  return defaults;
}

function parseLimits(raw: JsonValue, path: string): AudienceLimits {
  if (!isJsonObject(raw)) refuse("schema", `${path} must be an object`);
  const limits: MutableAudienceLimits = {};
  const maxDelegationDepth = readOptionalPositiveInt(
    raw,
    "maxDelegationDepth",
    path,
  );
  if (maxDelegationDepth !== undefined) {
    limits.maxDelegationDepth = maxDelegationDepth;
  }
  const requireIndependentApprover = readOptionalBoolean(
    raw,
    "requireIndependentApprover",
    path,
  );
  if (requireIndependentApprover !== undefined) {
    limits.requireIndependentApprover = requireIndependentApprover;
  }
  const forbidSecretReadFromSupervision = readOptionalBoolean(
    raw,
    "forbidSecretReadFromSupervision",
    path,
  );
  if (forbidSecretReadFromSupervision !== undefined) {
    limits.forbidSecretReadFromSupervision = forbidSecretReadFromSupervision;
  }
  const endOfEngagementTerminates = readOptionalBoolean(
    raw,
    "endOfEngagementTerminates",
    path,
  );
  if (endOfEngagementTerminates !== undefined) {
    limits.endOfEngagementTerminates = endOfEngagementTerminates;
  }
  const observerOnlyAllowed = readOptionalBoolean(
    raw,
    "observerOnlyAllowed",
    path,
  );
  if (observerOnlyAllowed !== undefined) {
    limits.observerOnlyAllowed = observerOnlyAllowed;
  }
  return limits;
}

/** Parse and validate one template document. */
export function parseAudienceTemplate(raw: JsonValue): AudienceTemplate {
  assertNoForbiddenKeys(raw, "template");
  if (!isJsonObject(raw)) refuse("schema", "template must be an object");
  const idRaw = readString(raw, "id", "template");
  if (!isAudienceId(idRaw)) {
    refuse(
      "schema",
      `template.id ${idRaw} is not a known audience template id`,
    );
  }
  const version = readString(raw, "version", "template");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    refuse("schema", "template.version must be semver N.N.N");
  }
  const label = readString(raw, "label", "template");
  const summary = readString(raw, "summary", "template");
  if (raw.vocabulary === undefined) {
    refuse("schema", "template.vocabulary is required");
  }
  if (raw.defaults === undefined) {
    refuse("schema", "template.defaults is required");
  }
  const vocabulary = parseVocabulary(raw.vocabulary, "template.vocabulary");
  const defaults = parseDefaults(raw.defaults, "template.defaults");
  if (idRaw === "family" && defaults.usageAccounting === undefined) {
    refuse(
      "schema",
      "family template must state usageAccounting (per_device or wall_clock_union)",
    );
  }
  const limits =
    raw.limits === undefined ? {} : parseLimits(raw.limits, "template.limits");
  const matrixRaw = raw.supportMatrix;
  if (!Array.isArray(matrixRaw) || matrixRaw.length === 0) {
    refuse("schema", "template.supportMatrix must be a non-empty array");
  }
  const supportMatrix = matrixRaw.map((entry, index) =>
    parseSupportClaim(entry, `template.supportMatrix[${index}]`),
  );
  return {
    id: idRaw,
    version,
    label,
    summary,
    vocabulary,
    defaults,
    limits,
    supportMatrix,
    workflowHints: readStringList(raw, "workflowHints", "template"),
  };
}

/** Validate a catalog: unique ids, every entry parses, no engine keys. */
export function parseAudienceTemplateCatalog(
  raw: JsonValue,
): readonly AudienceTemplate[] {
  if (!Array.isArray(raw)) refuse("schema", "catalog must be an array");
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const template = parseAudienceTemplate(entry);
    if (seen.has(template.id)) {
      refuse("schema", `duplicate template id ${template.id} at [${index}]`);
    }
    seen.add(template.id);
    return template;
  });
}
