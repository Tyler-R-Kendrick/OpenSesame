/**
 * GA-A-01 — TypeScript AuthorityGrant (authority record).
 *
 * Mirrors `crates/domain/src/grant.rs` so Identity/Pages share one record shape
 * with the Host plane. Naming stays Grant-shaped (ADR 0120); AccessLease remains
 * a separate compatibility concern (GA-O-03).
 */

import { DomainError } from "./errors.js";
import type { JsonObject } from "./json.js";
import {
  parseResourceScope,
  scopeContains,
  scopeMatches,
} from "./permission-scope.js";

/**
 * Product default for root-grant `maximumDelegationDepth` (GA-A-03 / INV-GA-04).
 *
 * Host ValidatedGrantChain and adversarial fixtures use depth 2 as the working
 * bound. Roots may set a lower per-grant maximum; this constant is the ceiling
 * Identity/Pages use when minting a new root without an explicit policy.
 */
export const DEFAULT_MAXIMUM_DELEGATION_DEPTH = 2;

export const OFFLINE_USE = [
  "forbidden",
  "read_only",
  "pre_authorized",
] as const;
export type OfflineUse = (typeof OFFLINE_USE)[number];

export type AuthorityGrantConstraints = {
  readonly audiences: readonly string[];
  readonly notBefore: Date | null;
  readonly expiresAt: Date;
  readonly requiredAssurance: string | null;
  readonly authenticationMaxAgeSeconds: number | null;
  readonly allowedNetworks: readonly string[];
  readonly parameterRulesDigest: string | null;
  readonly budgets: Readonly<Record<string, number>>;
  readonly maximumDelegationDepth: number;
  readonly offlineUse: OfflineUse;
  readonly rawCredentialExport: boolean;
};

/**
 * Canonical authority record. Prefer this name in TS product code; wire JSON
 * may still say `grant` to match Host serde.
 */
export type AuthorityGrant = {
  readonly id: string;
  readonly version: number;
  readonly issuerPrincipalId: string;
  readonly beneficiaryPrincipalId: string;
  readonly actorId: string | null;
  readonly clientId: string | null;
  readonly actorInstanceId: string | null;
  readonly proofKeyThumbprint: string | null;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly environmentId: string | null;
  readonly connectionId: string | null;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  readonly constraints: AuthorityGrantConstraints;
  readonly parentGrantId: string | null;
  readonly delegationDepth: number;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
};

/** Alias kept for GA-A-01 wording in the completion matrix. */
export type AuthorityRecord = AuthorityGrant;

export function isOfflineUse(value: string): value is OfflineUse {
  for (const mode of OFFLINE_USE) {
    if (mode === value) return true;
  }
  return false;
}

export function assertAuthorityGrantActive(
  grant: AuthorityGrant,
  now: Date,
): void {
  if (grant.revokedAt !== null) {
    throw new DomainError("INVARIANT_VIOLATION", "Authority grant is revoked", {
      invariant: "INV-GA-07",
      grantId: grant.id,
    });
  }
  const { notBefore, expiresAt } = grant.constraints;
  if (notBefore !== null && now < notBefore) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Authority grant is not yet valid",
      { invariant: "INV-GA-05", grantId: grant.id },
    );
  }
  if (now >= expiresAt) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Authority grant has expired",
      { invariant: "INV-GA-05", grantId: grant.id },
    );
  }
}

export function authorityGrantPermitsResource(
  grant: AuthorityGrant,
  resource: string,
): boolean {
  return grant.resources.some((pattern) => {
    try {
      return scopeMatches(parseResourceScope(pattern), resource);
    } catch {
      return false;
    }
  });
}

export function stringListIsSubset(
  child: readonly string[],
  parent: readonly string[],
): boolean {
  return child.every((c) => parent.some((p) => p === c));
}

export function resourcesAttenuate(
  child: readonly string[],
  parent: readonly string[],
): boolean {
  return child.every((c) => {
    try {
      const childScope = parseResourceScope(c);
      return parent.some((p) => {
        try {
          return scopeContains(parseResourceScope(p), childScope);
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  });
}

function attenuationError(why: string, details: JsonObject = {}): never {
  throw new DomainError("INVARIANT_VIOLATION", `Grant attenuation: ${why}`, {
    invariant: "INV-GA-01",
    why,
    ...details,
  });
}

function assuranceRank(name: string): number | null {
  switch (name) {
    case "phishing-resistant":
      return 3;
    case "mfa":
      return 2;
    case "pwd":
    case "password":
      return 1;
    default:
      return null;
  }
}

function offlineRank(mode: OfflineUse): number {
  switch (mode) {
    case "forbidden":
      return 0;
    case "read_only":
      return 1;
    case "pre_authorized":
      return 2;
  }
}

function validateTimeAttenuation(
  parent: AuthorityGrantConstraints,
  child: AuthorityGrantConstraints,
): void {
  if (child.expiresAt.getTime() > parent.expiresAt.getTime()) {
    attenuationError("lifetime expanded");
  }
  if (parent.notBefore !== null) {
    if (child.notBefore === null) {
      attenuationError("not_before omitted under restricted parent");
    } else if (child.notBefore.getTime() < parent.notBefore.getTime()) {
      attenuationError("not_before earlier than parent");
    }
  }
  if (
    child.notBefore !== null &&
    child.expiresAt.getTime() <= child.notBefore.getTime()
  ) {
    attenuationError("empty or inverted validity interval");
  }
}

function validateAssuranceAttenuation(
  parent: AuthorityGrantConstraints,
  child: AuthorityGrantConstraints,
): void {
  if (parent.requiredAssurance === null) return;
  if (child.requiredAssurance === null) {
    attenuationError("required_assurance dropped");
  }
  const parentRank = assuranceRank(parent.requiredAssurance);
  const childRank = assuranceRank(child.requiredAssurance);
  if (parentRank === null || childRank === null || childRank < parentRank) {
    attenuationError("required_assurance weakened");
  }
}

function validateAuthAgeAttenuation(
  parent: AuthorityGrantConstraints,
  child: AuthorityGrantConstraints,
): void {
  if (parent.authenticationMaxAgeSeconds === null) return;
  if (child.authenticationMaxAgeSeconds === null) {
    attenuationError("authentication_max_age omitted");
  } else if (
    child.authenticationMaxAgeSeconds > parent.authenticationMaxAgeSeconds
  ) {
    attenuationError("authentication_max_age expanded");
  }
}

function validateBudgetAttenuation(
  parent: AuthorityGrantConstraints,
  child: AuthorityGrantConstraints,
): void {
  for (const [key, parentBudget] of Object.entries(parent.budgets)) {
    const childBudget = child.budgets[key];
    if (childBudget === undefined) {
      attenuationError("budget key omitted", { key });
    } else if (childBudget > parentBudget) {
      attenuationError("budget expanded", { key });
    } else if (!Number.isInteger(childBudget) || childBudget < 0) {
      attenuationError("budget malformed", { key });
    }
  }
}

function validateConstraintAttenuation(
  parent: AuthorityGrantConstraints,
  child: AuthorityGrantConstraints,
): void {
  validateTimeAttenuation(parent, child);
  validateAssuranceAttenuation(parent, child);
  validateAuthAgeAttenuation(parent, child);
  if (
    parent.allowedNetworks.length > 0 &&
    !stringListIsSubset(child.allowedNetworks, parent.allowedNetworks)
  ) {
    attenuationError("allowed_networks expanded");
  }
  if (
    parent.parameterRulesDigest !== null &&
    child.parameterRulesDigest !== parent.parameterRulesDigest
  ) {
    attenuationError("parameter_rules_digest changed");
  }
  if (offlineRank(child.offlineUse) > offlineRank(parent.offlineUse)) {
    attenuationError("offline_use relaxed");
  }
  if (child.rawCredentialExport && !parent.rawCredentialExport) {
    attenuationError("raw_credential_export enabled");
  }
  validateBudgetAttenuation(parent, child);
  if (child.maximumDelegationDepth > parent.maximumDelegationDepth) {
    attenuationError("maximum_delegation_depth expanded");
  }
}

/**
 * Child grants may only attenuate authority (INV-GA-01).
 */
export function validateAuthorityGrantAttenuation(
  parent: AuthorityGrant,
  child: AuthorityGrant,
): void {
  if (child.parentGrantId !== parent.id) {
    attenuationError("parent_grant_id mismatch", {
      expected: parent.id,
      got: child.parentGrantId,
    });
  }
  if (child.organizationId !== parent.organizationId) {
    attenuationError("organization_id changed");
  }
  if (child.delegationDepth !== parent.delegationDepth + 1) {
    attenuationError("delegation_depth not parent+1", {
      parent: parent.delegationDepth,
      child: child.delegationDepth,
    });
  }
  if (child.delegationDepth > parent.constraints.maximumDelegationDepth) {
    attenuationError("delegation_depth exceeds parent maximum", {
      depth: child.delegationDepth,
      maximum: parent.constraints.maximumDelegationDepth,
    });
  }
  if (!stringListIsSubset(child.actions, parent.actions)) {
    attenuationError("actions expanded");
  }
  if (!resourcesAttenuate(child.resources, parent.resources)) {
    attenuationError("resources expanded");
  }
  if (parent.constraints.audiences.length > 0) {
    if (child.constraints.audiences.length === 0) {
      attenuationError("audiences cleared under restricted parent");
    }
    if (
      !stringListIsSubset(
        child.constraints.audiences,
        parent.constraints.audiences,
      )
    ) {
      attenuationError("audiences expanded");
    }
  }
  validateConstraintAttenuation(parent.constraints, child.constraints);
}
