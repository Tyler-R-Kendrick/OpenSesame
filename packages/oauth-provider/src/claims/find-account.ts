import type { Configuration } from "oidc-provider";
import {
  type AccountPrincipal,
  type ClaimMapping,
  type MapClaims,
  type ProjectAccountClaimsInput,
  projectAccountClaims,
} from "./project-account-claims.js";

export type { MapClaims };

export type AccountLookup = {
  principal: AccountPrincipal;
  mapping?: ClaimMapping;
  consented?: readonly string[];
};

export type LookupAccount = (
  id: string,
  clientId?: string,
) => Promise<AccountLookup | null>;

export type FindAccountOptions = {
  lookupAccount?: LookupAccount;
  mapClaims?: MapClaims;
};

function clientIdOf(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const oidc = (ctx as { oidc?: { client?: { clientId?: unknown } } }).oidc;
  return typeof oidc?.client?.clientId === "string"
    ? oidc.client.clientId
    : undefined;
}

function isUnavailable(principal: AccountPrincipal | undefined): boolean {
  return principal?.status === "suspended" || principal?.status === "missing";
}

function claimsInput(
  id: string,
  scope: string | undefined,
  lookup: AccountLookup | undefined,
  mapClaims: MapClaims | undefined,
): ProjectAccountClaimsInput {
  const input: ProjectAccountClaimsInput = { pairwiseSub: id };
  if (scope !== undefined) input.scope = scope;
  if (lookup?.principal) input.principal = lookup.principal;
  if (lookup?.mapping) input.mapping = lookup.mapping;
  if (lookup?.consented) input.consented = lookup.consented;
  if (mapClaims) input.mapClaims = mapClaims;
  return input;
}

/**
 * oidc-provider `findAccount`. Default (no lookup) keeps today's behaviour:
 * any id is an active pairwise subject with only `sub`. When `lookupAccount`
 * is provided, missing/suspended principals yield no account (ADV-17).
 */
export function createFindAccount(
  options: FindAccountOptions = {},
): NonNullable<Configuration["findAccount"]> {
  return async (ctx, id) => {
    let lookup: AccountLookup | undefined;
    if (options.lookupAccount) {
      const clientId = clientIdOf(ctx);
      const found = await options.lookupAccount(id, clientId);
      if (found == null || isUnavailable(found.principal)) return undefined;
      lookup = found;
    }
    return {
      accountId: id,
      async claims(_use: string, scope: string) {
        return projectAccountClaims(
          claimsInput(id, scope, lookup, options.mapClaims),
        );
      },
    };
  };
}
