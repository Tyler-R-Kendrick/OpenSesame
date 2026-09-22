/**
 * Validator for a CapabilityDescriptor, plus the descriptor types.
 *
 * Strict: unknown keys — especially security-relevant ones — make the
 * descriptor invalid, never ignored. Function-valued fields are rejected
 * outright: a descriptor is data, not code.
 */
import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { validatePrivileges } from "./descriptor-privileges.js";
import {
  type CapabilityId,
  type ModuleId,
  type OperationId,
  capabilityId,
  moduleId,
  operationId,
} from "./ids.js";

export type ExecutionEnvironment =
  | "document"
  | "dedicated-worker"
  | "shared-worker"
  | "service-worker";

export const EXECUTION_ENVIRONMENTS: readonly ExecutionEnvironment[] = [
  "document",
  "dedicated-worker",
  "shared-worker",
  "service-worker",
];

export function isExecutionEnvironment(value: BoundaryValue): boolean {
  return (
    isString(value) &&
    (EXECUTION_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

export type DescriptorClass = "core" | "shared" | "optional";

export const DESCRIPTOR_CLASSES: readonly DescriptorClass[] = [
  "core",
  "shared",
  "optional",
];

export type DeclaredPrivileges = {
  readonly egressOrigins: readonly string[];
  readonly keyAccess: {
    readonly vaultRead: boolean;
    readonly vaultWrite: boolean;
    readonly deviceKeys: boolean;
  };
  readonly browserPermissions: readonly string[];
};

export type WorkerGraphConstraint = {
  readonly requiresWorker: boolean;
  readonly allowedEnvironments: readonly ExecutionEnvironment[];
};

export type CapabilityDescriptor = {
  readonly id: CapabilityId;
  readonly descriptorVersion: number;
  readonly title: string;
  readonly summary: string;
  readonly dependencies: readonly CapabilityId[];
  readonly operationIds: readonly OperationId[];
  readonly moduleIds: readonly ModuleId[];
  readonly environments: readonly ExecutionEnvironment[];
  readonly exposureDigest: string;
  readonly requiresDocumentReload: boolean;
  readonly workerGraphConstraint?: WorkerGraphConstraint;
  readonly class?: DescriptorClass;
  readonly declaredPrivileges: DeclaredPrivileges;
};

export type DescriptorValidationFailure = {
  readonly field: string;
  readonly problem: string;
};

export type DescriptorValidation =
  | { readonly ok: true; readonly descriptor: CapabilityDescriptor }
  | {
      readonly ok: false;
      readonly failures: readonly DescriptorValidationFailure[];
    };

const EXPOSURE_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const BROWSER_PERMISSION_PATTERN = /^[a-z][a-zA-Z0-9-]{0,63}$/;
const MAX_TEXT = 200;
const MAX_LIST = 64;

/**
 * Validate one descriptor. Returns every failure found, or the descriptor
 * with its id lists deduplicated.
 */
export function validateDescriptor(value: BoundaryValue): DescriptorValidation {
  const failures: DescriptorValidationFailure[] = [];
  const push = (field: string, problem: string): void => {
    failures.push({ field, problem });
  };
  if (!isJsonObject(value)) {
    return {
      ok: false,
      failures: [{ field: "", problem: "descriptor must be an object" }],
    };
  }
  const allowed = new Set([
    "id",
    "descriptorVersion",
    "title",
    "summary",
    "dependencies",
    "operationIds",
    "moduleIds",
    "environments",
    "exposureDigest",
    "requiresDocumentReload",
    "workerGraphConstraint",
    "class",
    "declaredPrivileges",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) push(key, "unknown field");
  }

  const id = capabilityId(value.id);
  if (id === undefined) push("id", "not a capability id");

  const version =
    isNumber(value.descriptorVersion) &&
    Number.isInteger(value.descriptorVersion) &&
    value.descriptorVersion >= 1
      ? value.descriptorVersion
      : undefined;
  if (version === undefined) {
    push("descriptorVersion", "must be a positive integer");
  }

  const title = textAt(value.title, 1, MAX_TEXT);
  if (title === undefined) push("title", "string 1..200");
  const summary = textAt(value.summary, 0, MAX_TEXT);
  if (summary === undefined) push("summary", "string 0..200");

  const dependencies = idList(
    value.dependencies,
    "dependencies",
    push,
    capabilityId,
  );
  const operationIds = idList(
    value.operationIds,
    "operationIds",
    push,
    operationId,
  );
  const moduleIds = idList(value.moduleIds, "moduleIds", push, moduleId);

  const environments: ExecutionEnvironment[] = [];
  if (!isList(value.environments)) {
    push("environments", "must be an array");
  } else {
    for (const env of value.environments) {
      if (!isExecutionEnvironment(env)) {
        push("environments", `unknown environment ${stringify(env)}`);
      } else if (!environments.includes(overlapCast(env))) {
        environments.push(overlapCast(env));
      }
    }
    if (environments.length === 0)
      push("environments", "at least one environment");
  }

  const exposureDigest =
    isString(value.exposureDigest) &&
    EXPOSURE_DIGEST_PATTERN.test(value.exposureDigest)
      ? value.exposureDigest
      : undefined;
  if (exposureDigest === undefined) {
    push("exposureDigest", "16 lowercase hex characters");
  }

  if (!isBoolean(value.requiresDocumentReload)) {
    push("requiresDocumentReload", "must be boolean");
  }

  let workerGraphConstraint: WorkerGraphConstraint | undefined;
  const worker = value.workerGraphConstraint;
  if (worker === undefined) {
    // optional field stays absent
  } else if (!isJsonObject(worker)) {
    push("workerGraphConstraint", "must be an object when present");
  } else {
    workerGraphConstraint = validateWorkerConstraint(worker, push);
  }

  let descriptorClass: DescriptorClass | undefined;
  const klass = value.class;
  if (klass === undefined) {
    // optional field stays absent
  } else if (
    !isString(klass) ||
    !(DESCRIPTOR_CLASSES as readonly string[]).includes(klass)
  ) {
    push("class", `"core" | "shared" | "optional"`);
  } else {
    descriptorClass = overlapCast(klass);
  }

  const declaredPrivileges = validatePrivileges(value.declaredPrivileges, push);

  if (failures.length > 0) return { ok: false, failures };
  if (
    id === undefined ||
    version === undefined ||
    title === undefined ||
    summary === undefined ||
    exposureDigest === undefined ||
    declaredPrivileges === undefined ||
    !isBoolean(value.requiresDocumentReload)
  ) {
    return { ok: false, failures };
  }
  return {
    ok: true,
    descriptor: {
      id,
      descriptorVersion: version,
      title,
      summary,
      dependencies,
      operationIds,
      moduleIds,
      environments,
      exposureDigest,
      requiresDocumentReload: value.requiresDocumentReload,
      ...(workerGraphConstraint === undefined ? {} : { workerGraphConstraint }),
      ...(descriptorClass === undefined ? {} : { class: descriptorClass }),
      declaredPrivileges,
    },
  };
}

function validateWorkerConstraint(
  worker: JsonObject,
  push: (field: string, problem: string) => void,
): WorkerGraphConstraint | undefined {
  for (const key of Object.keys(worker)) {
    if (key !== "requiresWorker" && key !== "allowedEnvironments") {
      push(`workerGraphConstraint.${key}`, "unknown field");
    }
  }
  let ok = true;
  if (!isBoolean(worker.requiresWorker)) {
    push("workerGraphConstraint.requiresWorker", "must be boolean");
    ok = false;
  }
  const allowed: ExecutionEnvironment[] = [];
  if (!isList(worker.allowedEnvironments)) {
    push("workerGraphConstraint.allowedEnvironments", "must be an array");
    ok = false;
  } else {
    for (const env of worker.allowedEnvironments) {
      if (!isExecutionEnvironment(env)) {
        push(
          "workerGraphConstraint.allowedEnvironments",
          `unknown environment ${stringify(env)}`,
        );
        ok = false;
      } else if (!allowed.includes(overlapCast(env))) {
        allowed.push(overlapCast(env));
      }
    }
  }
  if (!ok) return undefined;
  return {
    requiresWorker: worker.requiresWorker as boolean,
    allowedEnvironments: allowed,
  };
}

function textAt(
  value: BoundaryValue,
  min: number,
  max: number,
): string | undefined {
  if (!isString(value)) return undefined;
  return value.length >= min && value.length <= max ? value : undefined;
}

function isList(value: BoundaryValue): value is BoundaryValue[] {
  return Array.isArray(value);
}

function stringify(value: BoundaryValue): string {
  return isString(value) ? JSON.stringify(value) : String(value);
}

function idList<Branded extends string>(
  value: BoundaryValue,
  field: string,
  push: (field: string, problem: string) => void,
  brand: (value: BoundaryValue) => Branded | undefined,
): readonly Branded[] {
  if (!isList(value)) {
    push(field, "must be an array");
    return [];
  }
  if (value.length > MAX_LIST) {
    push(field, `more than ${MAX_LIST} entries`);
    return [];
  }
  const out: Branded[] = [];
  for (const entry of value) {
    const branded = brand(entry);
    if (branded === undefined) {
      push(field, `malformed id ${stringify(entry)}`);
      continue;
    }
    if (!out.includes(branded)) out.push(branded);
  }
  return out;
}
