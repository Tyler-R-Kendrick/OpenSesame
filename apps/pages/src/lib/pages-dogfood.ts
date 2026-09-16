/**
 * Scopes this origin registers for itself. Access › Policies dogfoods them.
 */

import type { LocalScopeRoles } from "./local-application-policy.js";
import { APPLICATION_ROLES } from "./local-application-policy.js";

export const PAGES_DOGFOOD_SCOPES = [
  "openid",
  "profile",
  "records:read",
] as const;

export function pagesDogfoodScopeRoles(): LocalScopeRoles[] {
  return PAGES_DOGFOOD_SCOPES.map((scope) => ({
    scope,
    roles:
      scope === "records:read" ? (["owner"] as const) : [...APPLICATION_ROLES],
  }));
}
