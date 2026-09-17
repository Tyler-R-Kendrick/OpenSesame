/**
 * GA-A-02 — Executable INV-GA assertions for the Identity/TS plane.
 *
 * Host/Rust remains the dispatch authority. These asserts keep product code from
 * inventing a second attenuation algebra or treating a ConnectionRef as a secret.
 */

import {
  type AuthorityGrant,
  DEFAULT_MAXIMUM_DELEGATION_DEPTH,
  assertAuthorityGrantActive,
  validateAuthorityGrantAttenuation,
} from "./authority-grant.js";
import { DomainError } from "./errors.js";

/** INV-GA-01: child authority may only narrow the parent. */
export function assertInvGa01Attenuation(
  parent: AuthorityGrant,
  child: AuthorityGrant,
): void {
  validateAuthorityGrantAttenuation(parent, child);
}

/**
 * INV-GA-02: agent-facing handles stay ConnectionRef-shaped — never a raw
 * credential or `getSecret`-style affordance on the authority record.
 */
export function assertInvGa02NoSecretOnAuthorityRecord(
  record: AuthorityGrant,
): void {
  const blob = JSON.stringify(record);
  const forbidden = [
    '"secret"',
    '"password"',
    '"privateKey"',
    '"private_key"',
    '"getSecret"',
    '"rawCredential"',
    '"raw_credential"',
  ] as const;
  for (const needle of forbidden) {
    if (blob.includes(needle)) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "Authority record must not carry secret material",
        { invariant: "INV-GA-02", needle },
      );
    }
  }
  if (record.constraints.rawCredentialExport) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Authority record must not enable raw credential export on the agent path",
      { invariant: "INV-GA-02", grantId: record.id },
    );
  }
}

/** INV-GA-04 / INV-GA-06: delegation depth is finite and non-cyclic by parent pointers. */
export function assertInvGa04FiniteDepth(
  chain: readonly AuthorityGrant[],
  depthBound: number = DEFAULT_MAXIMUM_DELEGATION_DEPTH,
): void {
  if (depthBound < 0 || !Number.isInteger(depthBound)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Delegation depth bound must be a non-negative integer",
      { invariant: "INV-GA-04", depthBound },
    );
  }
  if (chain.length === 0) {
    throw new DomainError("INVARIANT_VIOLATION", "Authority chain is empty", {
      invariant: "INV-GA-04",
    });
  }
  const seen = new Set<string>();
  for (let i = 0; i < chain.length; i += 1) {
    const grant = chain[i];
    if (grant === undefined) {
      throw new DomainError("INVARIANT_VIOLATION", "Authority chain gap", {
        invariant: "INV-GA-04",
        index: i,
      });
    }
    if (seen.has(grant.id)) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "Authority chain contains a cycle",
        { invariant: "INV-GA-06", grantId: grant.id },
      );
    }
    seen.add(grant.id);
    if (grant.delegationDepth > depthBound) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "Authority chain exceeds depth bound",
        {
          invariant: "INV-GA-04",
          depth: grant.delegationDepth,
          depthBound,
        },
      );
    }
    if (i === 0) {
      if (grant.parentGrantId !== null) {
        throw new DomainError(
          "INVARIANT_VIOLATION",
          "Root grant must not name a parent",
          { invariant: "INV-GA-04", grantId: grant.id },
        );
      }
      continue;
    }
    const parent = chain[i - 1];
    if (parent === undefined) {
      throw new DomainError("INVARIANT_VIOLATION", "Authority chain gap", {
        invariant: "INV-GA-04",
        index: i - 1,
      });
    }
    assertInvGa01Attenuation(parent, grant);
  }
}

/** INV-GA-05 / INV-GA-07: expiry and revocation are active state, not eventual. */
export function assertInvGa07ActiveState(
  grant: AuthorityGrant,
  now: Date,
): void {
  assertAuthorityGrantActive(grant, now);
}

/** INV-GA-08: budgets are conserved under attenuation (child ≤ parent per key). */
export function assertInvGa08BudgetConservation(
  parent: AuthorityGrant,
  child: AuthorityGrant,
): void {
  for (const [key, parentBudget] of Object.entries(
    parent.constraints.budgets,
  )) {
    const childBudget = child.constraints.budgets[key];
    if (childBudget === undefined) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "Child omitted a parent budget key",
        { invariant: "INV-GA-08", key },
      );
    }
    if (childBudget > parentBudget) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "Child budget exceeds parent",
        { invariant: "INV-GA-08", key, childBudget, parentBudget },
      );
    }
  }
}
