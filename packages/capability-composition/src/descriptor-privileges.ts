/**
 * Declared-privilege validation for capability descriptors. Split out so
 * each module stays under the 400-line budget (ADR 0093).
 */
import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type { DeclaredPrivileges } from "./descriptor.js";

const ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
const BROWSER_PERMISSION_PATTERN = /^[a-z][a-zA-Z0-9-]{0,63}$/;

type Push = (field: string, problem: string) => void;

/**
 * Validate the declared-privileges block. Returns the de-duplicated block,
 * or `undefined` when any part is malformed.
 */
export function validatePrivileges(
  value: BoundaryValue,
  push: Push,
): DeclaredPrivileges | undefined {
  if (!isJsonObject(value)) {
    push("declaredPrivileges", "must be an object");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "egressOrigins" &&
      key !== "keyAccess" &&
      key !== "browserPermissions"
    ) {
      push(`declaredPrivileges.${key}`, "unknown field");
    }
  }
  const egress = stringSet(
    value.egressOrigins,
    "declaredPrivileges.egressOrigins",
    ORIGIN_PATTERN,
    "bad origin",
    push,
  );
  const permissions = stringSet(
    value.browserPermissions,
    "declaredPrivileges.browserPermissions",
    BROWSER_PERMISSION_PATTERN,
    "bad permission",
    push,
  );
  const flags = validateKeyAccess(value.keyAccess, push);
  if (
    egress === undefined ||
    permissions === undefined ||
    flags === undefined
  ) {
    return undefined;
  }
  return {
    egressOrigins: egress,
    keyAccess: flags,
    browserPermissions: permissions,
  };
}

/** A de-duplicated string array whose entries match the pattern, or undefined. */
function stringSet(
  value: BoundaryValue,
  field: string,
  pattern: RegExp,
  problem: string,
  push: Push,
): string[] | undefined {
  if (!Array.isArray(value)) {
    push(field, "must be an array");
    return undefined;
  }
  const out: string[] = [];
  let ok = true;
  for (const entry of value) {
    if (!isString(entry) || !pattern.test(entry)) {
      push(field, `${problem} ${stringify(entry)}`);
      ok = false;
    } else if (!out.includes(entry)) {
      out.push(entry);
    }
  }
  return ok ? out : undefined;
}

/** The three key-access flags; every flag must be an explicit boolean. */
function validateKeyAccess(
  value: BoundaryValue,
  push: Push,
): DeclaredPrivileges["keyAccess"] | undefined {
  if (!isJsonObject(value)) {
    push("declaredPrivileges.keyAccess", "must be an object");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (key !== "vaultRead" && key !== "vaultWrite" && key !== "deviceKeys") {
      push(`declaredPrivileges.keyAccess.${key}`, "unknown field");
    }
  }
  if (
    !isBoolean(value.vaultRead) ||
    !isBoolean(value.vaultWrite) ||
    !isBoolean(value.deviceKeys)
  ) {
    push("declaredPrivileges.keyAccess", "every flag must be boolean");
    return undefined;
  }
  return {
    vaultRead: value.vaultRead,
    vaultWrite: value.vaultWrite,
    deviceKeys: value.deviceKeys,
  };
}

function stringify(value: BoundaryValue): string {
  return isString(value) ? JSON.stringify(value) : String(value);
}
