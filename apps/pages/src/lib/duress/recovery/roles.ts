/**
 * RECOVERY-A — custodial roles and custody-domain accounting.
 * Alert receive ≠ hold clear ≠ recovery approve ≠ key share hold ≠ owner.
 */

export type CustodyRole =
  | "alert_recipient"
  | "lock_custodian"
  | "recovery_approver"
  | "key_custodian"
  | "affected_owner";

export type CustodyAction =
  | "acknowledge_alert"
  | "request_hold"
  | "clear_hold"
  | "approve_recovery"
  | "release_share"
  | "authorize_reenroll"
  | "arm_policy";

export type CustodyGrant = Readonly<{
  principalRef: string;
  role: CustodyRole;
  /** Logical domain (e.g. icloud-sync, phone, hardware-token). Synced replicas share a domain. */
  custodyDomain: string;
  scopeRef: string;
  generation: number;
  revoked?: boolean;
}>;

const ROLE_ACTIONS = {
  alert_recipient: ["acknowledge_alert"],
  lock_custodian: ["request_hold", "clear_hold"],
  recovery_approver: ["approve_recovery"],
  key_custodian: ["release_share"],
  affected_owner: ["acknowledge_alert", "authorize_reenroll", "arm_policy"],
} satisfies Readonly<Record<CustodyRole, readonly CustodyAction[]>>;

export function roleAllows(
  grant: CustodyGrant,
  action: CustodyAction,
): boolean {
  if (grant.revoked) return false;
  return ROLE_ACTIONS[grant.role].some((entry) => entry === action);
}

/**
 * Count independent custody domains for key custodians (AT-070).
 * Multiple principals on one synced domain count as one independent custodian.
 */
export function countIndependentCustodians(
  grants: readonly CustodyGrant[],
): number {
  return new Set(
    grants
      .filter((g) => g.role === "key_custodian" && !g.revoked)
      .map((g) => g.custodyDomain),
  ).size;
}

/** Approvers counted by independent domain (approval quorum ≠ key custody). */
export function countIndependentApprovers(
  grants: readonly CustodyGrant[],
): number {
  return new Set(
    grants
      .filter((g) => g.role === "recovery_approver" && !g.revoked)
      .map((g) => g.custodyDomain),
  ).size;
}

/**
 * Reject circular custody: all key shares would live only inside a removed compartment.
 */
export function assertOutsideCompartmentCustody(input: {
  keyCustodianScopeRefs: readonly string[];
  removedCompartmentRefs: readonly string[];
  outsideCompartmentRefs: readonly string[];
}): void {
  const removed = new Set(input.removedCompartmentRefs);
  const outside = new Set(input.outsideCompartmentRefs);
  if (outside.size === 0) {
    throw new Error(
      "circular_recovery: no outside compartment for recovery material",
    );
  }
  const allInsideRemoved = input.keyCustodianScopeRefs.every((s) =>
    removed.has(s),
  );
  if (allInsideRemoved) {
    throw new Error(
      "circular_recovery: key custodian scopes only inside removed compartment",
    );
  }
  for (const scope of input.keyCustodianScopeRefs) {
    if (removed.has(scope) && !outside.has(scope)) {
      throw new Error(
        "circular_recovery: custodian scope is removed without outside listing",
      );
    }
  }
}
