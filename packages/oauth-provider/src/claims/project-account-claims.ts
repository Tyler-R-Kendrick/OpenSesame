import type { JsonObject, JsonValue } from "@opensesame/os-domain";

/**
 * Protocol claims the issuer owns. Mapping may never replace these; `sub` and
 * `aud` are a hard validation error (ADV-16), the rest are ignored.
 */
export const RESERVED_PROTOCOL_CLAIMS = [
  "sub",
  "iss",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
  "azp",
] as const;

const RESERVED = new Set<string>(RESERVED_PROTOCOL_CLAIMS);
const STANDARD_CLAIMS = new Set(["name", "email", "email_verified"]);

export class ReservedClaimError extends Error {
  readonly code = "reserved_claim";
  readonly claim: string;

  constructor(claim: string) {
    super(`mapping cannot override reserved protocol claim "${claim}"`);
    this.name = "ReservedClaimError";
    this.claim = claim;
  }
}

export type AccountStatus = "active" | "suspended" | "missing";

export type AccountPrincipal = {
  name?: string;
  email?: string;
  emailVerified?: boolean;
  /** False when the address came from an untrusted issuer. */
  emailAuthoritative?: boolean;
  groups?: readonly string[];
  roles?: readonly string[];
  orgId?: string;
  status?: AccountStatus;
};

export type ClaimMapping = {
  claims?: JsonObject;
  allow?: readonly string[];
  /** Directory claims (groups/roles) release only for this org. */
  orgId?: string;
};

export type ProjectAccountClaimsInput = {
  pairwiseSub: string;
  scope?: string | readonly string[];
  consented?: readonly string[];
  principal?: AccountPrincipal | null;
  mapping?: ClaimMapping | null;
  mapClaims?: MapClaims;
};

export type MapClaims = (
  input: ProjectAccountClaimsInput,
) => JsonObject | undefined;

export function isReservedProtocolClaim(name: string): boolean {
  return RESERVED.has(name);
}

function scopeSet(scope: string | readonly string[] | undefined): Set<string> {
  if (typeof scope === "string") {
    return new Set(scope.split(" ").filter((part) => part.length > 0));
  }
  if (Array.isArray(scope)) {
    return new Set(scope.filter((part) => part.length > 0));
  }
  return new Set();
}

function consentAllows(
  consented: readonly string[] | undefined,
  claim: string,
): boolean {
  return !consented || consented.includes(claim);
}

function mappingAllows(
  mapping: ClaimMapping | null | undefined,
  claim: string,
): boolean {
  if (!mapping?.allow) return STANDARD_CLAIMS.has(claim);
  return mapping.allow.includes(claim);
}

function isAuthoritativeEmail(principal: AccountPrincipal): boolean {
  if (!principal.email) return false;
  if (principal.emailAuthoritative === false) return false;
  return principal.emailVerified === true;
}

function fenceMappedClaim(
  name: string,
  value: JsonValue | undefined,
  out: JsonObject,
): void {
  if (value === undefined) return;
  if (name === "sub" || name === "aud") {
    throw new ReservedClaimError(name);
  }
  if (isReservedProtocolClaim(name)) return;
  out[name] = value;
}

function mergeMapped(out: JsonObject, extra: JsonObject | undefined): void {
  if (!extra) return;
  for (const [name, value] of Object.entries(extra)) {
    fenceMappedClaim(name, value, out);
  }
}

function discloseProfile(
  out: JsonObject,
  input: ProjectAccountClaimsInput,
  scopes: Set<string>,
): void {
  const name = input.principal?.name;
  if (!name || !scopes.has("profile")) return;
  if (!consentAllows(input.consented, "name")) return;
  if (!mappingAllows(input.mapping, "name")) return;
  out.name = name;
}

function discloseEmail(
  out: JsonObject,
  input: ProjectAccountClaimsInput,
  scopes: Set<string>,
): void {
  const principal = input.principal;
  if (!principal || !scopes.has("email")) return;
  if (!isAuthoritativeEmail(principal)) return;
  if (!consentAllows(input.consented, "email")) return;
  if (!mappingAllows(input.mapping, "email")) return;
  out.email = principal.email;
  out.email_verified = true;
}

function discloseDirectory(
  out: JsonObject,
  input: ProjectAccountClaimsInput,
): void {
  const mapping = input.mapping;
  const principal = input.principal;
  if (!mapping?.orgId || !principal || principal.orgId !== mapping.orgId) {
    return;
  }
  if (mappingAllows(mapping, "groups") && principal.groups) {
    out.groups = [...principal.groups];
  }
  if (mappingAllows(mapping, "roles") && principal.roles) {
    out.roles = [...principal.roles];
  }
}

/**
 * Unsigned claim set used by both token issuance (`findAccount.claims`) and
 * preview. Never signs; always emits the pairwise `sub`.
 */
export function projectAccountClaims(
  input: ProjectAccountClaimsInput,
): JsonObject {
  const out: JsonObject = { sub: input.pairwiseSub };
  const scopes = scopeSet(input.scope);
  discloseProfile(out, input, scopes);
  discloseEmail(out, input, scopes);
  discloseDirectory(out, input);
  mergeMapped(out, input.mapping?.claims);
  if (input.mapClaims) mergeMapped(out, input.mapClaims(input));
  return out;
}

/** Same projector as issuance; preview must never sign. */
export function previewAccountClaims(
  input: ProjectAccountClaimsInput,
): JsonObject {
  return projectAccountClaims(input);
}
