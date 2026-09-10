import {
  type BoundaryValue,
  type OrganizationRole,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

export const APPLICATION_ROLES: readonly OrganizationRole[] = [
  "owner",
  "admin",
  "member",
];
export type LocalScopeRoles = { scope: string; roles: OrganizationRole[] };

/** Legacy registrations admit identity only; other scopes need explicit policy. */
export function defaultScopeRoles(
  scopes: readonly string[],
): LocalScopeRoles[] {
  return scopes.map((scope) => ({
    scope,
    roles: scope === "openid" ? [...APPLICATION_ROLES] : [],
  }));
}

export function isScopeRoles(
  value: BoundaryValue,
  scopes: readonly string[],
): value is LocalScopeRoles[] {
  return (
    Array.isArray(value) &&
    value.length === scopes.length &&
    value.every(
      (row) =>
        isJsonObject(row) &&
        isString(row.scope) &&
        scopes.includes(row.scope) &&
        Array.isArray(row.roles) &&
        row.roles.length <= APPLICATION_ROLES.length &&
        row.roles.every(
          (role) => role === "owner" || role === "admin" || role === "member",
        ) &&
        new Set(row.roles).size === row.roles.length &&
        Object.keys(row).every((key) => key === "scope" || key === "roles"),
    ) &&
    new Set(value.map((row) => (isJsonObject(row) ? row.scope : null))).size ===
      value.length
  );
}

/** No implicit role hierarchy: an owner is not automatically allowed every scope. */
export function permitsApplicationScopes(
  policy: readonly LocalScopeRoles[],
  role: OrganizationRole,
  scopes: readonly string[],
): boolean {
  return scopes.every((scope) =>
    policy.some((row) => row.scope === scope && row.roles.includes(role)),
  );
}
