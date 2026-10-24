/** Boundary shape checks for vault-session records, apart from ledger rules. */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import type {
  LocalVaultSession,
  SessionGrantSpec,
  SessionSubject,
} from "./local-vault-session-types.js";

function text(value: BoundaryValue, max: number): value is string {
  return isString(value) && value.length > 0 && value.length <= max;
}

function isSubject(value: BoundaryValue): value is SessionSubject {
  if (!isJsonObject(value) || !isString(value.kind)) return false;
  if (value.kind === "principal") return text(value.principalId, 42);
  if (value.kind === "accessRole")
    return (
      value.role === "operator" ||
      value.role === "member" ||
      value.role === "guest"
    );
  if (value.kind === "orgRole")
    return (
      value.role === "owner" ||
      value.role === "admin" ||
      value.role === "member"
    );
  return false;
}

export function isGrantSpec(value: BoundaryValue): value is SessionGrantSpec {
  return (
    isJsonObject(value) &&
    isSubject(value.subject) &&
    (value.resourceKind === "vault" ||
      value.resourceKind === "connection" ||
      value.resourceKind === "folder" ||
      value.resourceKind === "item") &&
    text(value.resourceId, 128) &&
    text(value.resourceLabel, 128) &&
    text(value.policy, 32)
  );
}

function isOptionalTime(value: BoundaryValue): boolean {
  return (
    value === null ||
    (isNumber(value) && Number.isSafeInteger(value) && value >= 0)
  );
}

function isSessionTiming(value: Record<string, BoundaryValue>): boolean {
  return (
    isNumber(value.durationSeconds) &&
    Number.isSafeInteger(value.durationSeconds) &&
    value.durationSeconds >= 60 &&
    value.durationSeconds <= 7 * 86400 &&
    isOptionalTime(value.startedAt) &&
    isOptionalTime(value.expiresAt)
  );
}

export function isSession(value: BoundaryValue): value is LocalVaultSession {
  return (
    isJsonObject(value) &&
    text(value.id, 36) &&
    text(value.code, 12) &&
    text(value.label, 128) &&
    (value.status === "running" || value.status === "stopped") &&
    isSessionTiming(value) &&
    text(value.boundTomb, 128) &&
    Array.isArray(value.grants) &&
    value.grants.length <= 64 &&
    value.grants.every(isGrantSpec) &&
    Array.isArray(value.issuedShareIds) &&
    value.issuedShareIds.every((id) => text(id, 36))
  );
}
