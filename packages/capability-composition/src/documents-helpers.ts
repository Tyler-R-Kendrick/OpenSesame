/**
 * Private validators shared by the document validators. Split out so each
 * module stays under the 400-line budget.
 */
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type AllowSet,
  DOCUMENT_LIMITS,
  type NetworkPolicy,
  type UpdatesPolicy,
} from "./documents.js";
import { type DocumentKind, capabilityId } from "./ids.js";

export type Fail = (field: string, problem: string) => void;

const ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const PLAIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Shape + schemaVersion + kind gate; false means "stop, nothing else is readable". */
export function validateBase(
  value: BoundaryValue,
  kind: DocumentKind,
  push: Fail,
): value is JsonObject {
  if (!isJsonObject(value)) {
    push("", "document must be an object");
    return false;
  }
  if (value.schemaVersion !== 1) {
    push("schemaVersion", "must be exactly 1");
  }
  if (value.kind !== kind) {
    push("kind", `must be "${kind}"`);
  }
  return isNumber(value.schemaVersion) && value.schemaVersion === 1;
}

/** Report every key that is not in the allow-list. */
export function rejectUnknown(
  value: JsonObject,
  allowed: readonly string[],
  push: Fail,
): void {
  const ok = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!ok.has(key)) push(key, "unknown field");
  }
}

/** A plain document identifier (instance/vault/installation ids). */
export function plainId(
  value: BoundaryValue,
  field: string,
  push: Fail,
): string | undefined {
  if (!isString(value) || !PLAIN_ID_PATTERN.test(value)) {
    push(field, "identifier 1..200 chars, [A-Za-z0-9._:-]");
    return undefined;
  }
  return value;
}

/** A non-negative integer revision, or undefined when malformed. */
export function readRevision(
  value: BoundaryValue,
  push: Fail,
): number | undefined {
  if (
    !isNumber(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    push("revision", "non-negative integer");
    return undefined;
  }
  return value;
}

/** A capability-id array, de-duplicated; malformed entries are reported. */
export function idArray(
  value: BoundaryValue,
  field: string,
  push: Fail,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    push(field, "must be an array when present");
    return [];
  }
  if (value.length > DOCUMENT_LIMITS.maxCapabilities) {
    push(field, `more than ${DOCUMENT_LIMITS.maxCapabilities} entries`);
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    const id = capabilityId(entry);
    if (id === undefined) {
      push(field, "malformed capability id");
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** `"inherit"`, an explicit `{ ids }` set, or undefined when malformed. */
export function readAllowSet(
  value: BoundaryValue,
  push: Fail,
): AllowSet | undefined {
  if (value === undefined) return "inherit";
  if (value === "inherit") return "inherit";
  if (!isJsonObject(value)) {
    push("allow", `"inherit" or { ids: [...] }`);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (key !== "ids") push("allow", "unknown field inside allow");
  }
  const ids = value.ids;
  if (!Array.isArray(ids)) {
    push("allow.ids", "must be an array");
    return undefined;
  }
  if (ids.length > DOCUMENT_LIMITS.maxCapabilities) {
    push("allow.ids", `more than ${DOCUMENT_LIMITS.maxCapabilities} entries`);
    return undefined;
  }
  const out: string[] = [];
  for (const entry of ids) {
    const id = capabilityId(entry);
    if (id === undefined) {
      push("allow.ids", "malformed capability id");
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return { ids: out };
}

/** The network block of an instance policy. */
export function validateNetwork(
  value: BoundaryValue,
  push: Fail,
): NetworkPolicy | undefined {
  if (!isJsonObject(value)) {
    push("network", "must be an object");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (key !== "externalServices" && key !== "allowedServiceOrigins") {
      push("network", "unknown field");
    }
  }
  if (
    !isString(value.externalServices) ||
    (value.externalServices !== "allow" && value.externalServices !== "deny")
  ) {
    push("network.externalServices", `"allow" | "deny"`);
    return undefined;
  }
  const origins: string[] = [];
  if (value.allowedServiceOrigins !== undefined) {
    if (!Array.isArray(value.allowedServiceOrigins)) {
      push("network.allowedServiceOrigins", "must be an array");
      return undefined;
    }
    if (value.allowedServiceOrigins.length > DOCUMENT_LIMITS.maxOrigins) {
      push(
        "network.allowedServiceOrigins",
        `more than ${DOCUMENT_LIMITS.maxOrigins} entries`,
      );
      return undefined;
    }
    for (const origin of value.allowedServiceOrigins) {
      if (!isString(origin) || !ORIGIN_PATTERN.test(origin)) {
        push("network.allowedServiceOrigins", "bad origin");
        continue;
      }
      if (!origins.includes(origin)) origins.push(origin);
    }
  }
  return {
    externalServices: value.externalServices,
    allowedServiceOrigins: origins,
  };
}

/** The updates block of an instance policy. */
export function validateUpdates(
  value: BoundaryValue,
  push: Fail,
): UpdatesPolicy | undefined {
  if (!isJsonObject(value)) {
    push("updates", "must be an object");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (key !== "unknownCapabilities" && key !== "expandedExposure") {
      push("updates", "unknown field");
    }
  }
  let unknown: "deny" | "review" | undefined;
  let exposure: "require-approval" | "allow" | undefined;
  if (
    isString(value.unknownCapabilities) &&
    (value.unknownCapabilities === "deny" ||
      value.unknownCapabilities === "review")
  ) {
    unknown = value.unknownCapabilities;
  } else {
    push("updates.unknownCapabilities", `"deny" | "review"`);
  }
  if (
    isString(value.expandedExposure) &&
    (value.expandedExposure === "require-approval" ||
      value.expandedExposure === "allow")
  ) {
    exposure = value.expandedExposure;
  } else {
    push("updates.expandedExposure", `"require-approval" | "allow"`);
  }
  if (unknown === undefined || exposure === undefined) return undefined;
  return { unknownCapabilities: unknown, expandedExposure: exposure };
}
