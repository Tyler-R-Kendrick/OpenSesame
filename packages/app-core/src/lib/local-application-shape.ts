/**
 * The stored shape of a local application registration and its boundary
 * checks — pure, no storage, no actor. `local-applications.ts` owns reads,
 * writes and who may make them.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { exactOrigin } from "@opensesame/static-auth";
import {
  type LocalScopeRoles,
  isScopeRoles,
} from "./local-application-policy.js";

export type LocalApplicationRegistration = {
  applicationId: string;
  organizationId: string;
  redirectUris: string[];
  scopes: string[];
  scopeRoles?: LocalScopeRoles[];
};
export type LocalApplication = LocalApplicationRegistration & {
  revision: number;
};
export type LocalApplications = {
  version: 2;
  revision: number;
  applications: LocalApplication[];
};

export function validRedirect(raw: string): boolean {
  try {
    const url = new URL(raw);
    exactOrigin(url.origin);
    return (
      raw.length <= 2048 &&
      raw === url.href &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !raw.includes("#") &&
      !raw.includes("*")
    );
  } catch {
    return false;
  }
}
export function strings(value: BoundaryValue, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= max &&
    value.every(isString) &&
    new Set(value).size === value.length
  );
}
export function isRegistration(
  value: BoundaryValue,
): value is LocalApplicationRegistration {
  return (
    isJsonObject(value) &&
    isString(value.applicationId) &&
    /^local_[0-9a-f-]{36}$/.test(value.applicationId) &&
    isString(value.organizationId) &&
    /^local_[0-9a-f-]{36}$/.test(value.organizationId) &&
    strings(value.redirectUris, 16) &&
    value.redirectUris.every(validRedirect) &&
    strings(value.scopes, 32) &&
    value.scopes.includes("openid") &&
    value.scopes.every((scope) =>
      /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(scope),
    ) &&
    (value.scopeRoles === undefined ||
      isScopeRoles(value.scopeRoles, value.scopes))
  );
}
export function isApplication(value: BoundaryValue): value is LocalApplication {
  return (
    isJsonObject(value) &&
    isNumber(value.revision) &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    isRegistration(value)
  );
}
