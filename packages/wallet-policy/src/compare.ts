/**
 * Amount and constraint narrowing helpers.
 * Broader means more authority (higher ceiling, wider allow-list, longer window).
 */

import type {
  AmountUnits,
  AssetRef,
  BudgetWindow,
  PolicyConstraint,
} from "./types.js";

const AMOUNT_PATTERN = /^[0-9]+$/;

export function parseAmountUnits(value: AmountUnits): bigint {
  if (!AMOUNT_PATTERN.test(value)) {
    throw new RangeError(
      "AmountUnits must be a non-negative integer decimal string",
    );
  }
  return BigInt(value);
}

export function amountAtMost(left: AmountUnits, right: AmountUnits): boolean {
  return parseAmountUnits(left) <= parseAmountUnits(right);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function recipientSubset(
  candidate: readonly string[],
  allowed: readonly string[],
): boolean {
  if (allowed.length === 0) {
    return candidate.length === 0;
  }
  const allow = new Set(allowed);
  return candidate.every((entry) => allow.has(entry));
}

function assetEqual(left: AssetRef, right: AssetRef): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "fiat" && right.kind === "fiat") {
    return left.currency === right.currency && left.exponent === right.exponent;
  }
  if (left.kind === "token" && right.kind === "token") {
    return (
      left.chainId === right.chainId &&
      left.contract === right.contract &&
      left.decimals === right.decimals &&
      left.deploymentFingerprint === right.deploymentFingerprint
    );
  }
  return false;
}

function instantAtMost(left: string, right: string): boolean {
  return left <= right;
}

function instantAtLeast(left: string, right: string): boolean {
  return left >= right;
}

/**
 * Whether `candidate` is no broader than `ceiling` for the same kind.
 * Different kinds are incomparable (caller must match kinds first).
 */
export function isNoBroaderThan(
  candidate: PolicyConstraint,
  ceiling: PolicyConstraint,
): boolean {
  if (candidate.kind !== ceiling.kind) {
    return false;
  }
  switch (candidate.kind) {
    case "amount":
      return (
        ceiling.kind === "amount" &&
        amountAtMost(candidate.ceiling, ceiling.ceiling)
      );
    case "recipient":
      return (
        ceiling.kind === "recipient" &&
        recipientSubset(candidate.allowed, ceiling.allowed)
      );
    case "period":
      return (
        ceiling.kind === "period" &&
        periodNoBroader(candidate.window, ceiling.window)
      );
    case "fee":
      return (
        ceiling.kind === "fee" && amountAtMost(candidate.maxFee, ceiling.maxFee)
      );
    case "redelegation":
      return (
        ceiling.kind === "redelegation" &&
        candidate.maxDepth <= ceiling.maxDepth &&
        candidate.maxDepth >= 0
      );
    case "asset":
      return (
        ceiling.kind === "asset" && assetEqual(candidate.asset, ceiling.asset)
      );
  }
}

export function isBroaderThan(
  candidate: PolicyConstraint,
  ceiling: PolicyConstraint,
): boolean {
  return !isNoBroaderThan(candidate, ceiling);
}

function periodNoBroader(
  candidate: BudgetWindow,
  ceiling: BudgetWindow,
): boolean {
  if (candidate.kind !== ceiling.kind) {
    // Calendar vs fixed_interval vs lifetime are distinct semantics — never
    // treat a duration window as satisfying a calendar ceiling.
    return false;
  }
  if (candidate.kind === "lifetime" && ceiling.kind === "lifetime") {
    return (
      instantAtLeast(candidate.validFrom, ceiling.validFrom) &&
      instantAtMost(candidate.validUntil, ceiling.validUntil)
    );
  }
  if (
    candidate.kind === "fixed_interval" &&
    ceiling.kind === "fixed_interval"
  ) {
    return (
      amountAtMost(candidate.durationSeconds, ceiling.durationSeconds) &&
      instantAtMost(candidate.validUntil, ceiling.validUntil)
    );
  }
  if (candidate.kind === "calendar" && ceiling.kind === "calendar") {
    return (
      candidate.unit === ceiling.unit &&
      candidate.timeZone === ceiling.timeZone &&
      candidate.boundaryScheduleRef === ceiling.boundaryScheduleRef &&
      instantAtMost(candidate.validUntil, ceiling.validUntil)
    );
  }
  return false;
}

/** Tightest of two same-kind constraints (all-ancestor intersection). */
export function tighten(
  left: PolicyConstraint,
  right: PolicyConstraint,
): PolicyConstraint | null {
  if (left.kind !== right.kind) {
    return null;
  }
  const critical = left.critical || right.critical;
  switch (left.kind) {
    case "amount": {
      if (right.kind !== "amount") return null;
      const ceiling = amountAtMost(left.ceiling, right.ceiling)
        ? left.ceiling
        : right.ceiling;
      return {
        kind: "amount",
        ref: left.ref,
        ceiling,
        critical,
      };
    }
    case "recipient": {
      if (right.kind !== "recipient") return null;
      const rightSet = new Set(right.allowed);
      const allowed = sortedUnique(
        left.allowed.filter((entry) => rightSet.has(entry)),
      );
      return {
        kind: "recipient",
        ref: left.ref,
        allowed,
        critical,
      };
    }
    case "period": {
      if (right.kind !== "period") return null;
      if (left.window.kind !== right.window.kind) {
        return null;
      }
      if (isNoBroaderThan(left, right)) {
        return { ...left, critical };
      }
      if (isNoBroaderThan(right, left)) {
        return { ...right, ref: left.ref, critical };
      }
      return null;
    }
    case "fee": {
      if (right.kind !== "fee") return null;
      const maxFee = amountAtMost(left.maxFee, right.maxFee)
        ? left.maxFee
        : right.maxFee;
      return { kind: "fee", ref: left.ref, maxFee, critical };
    }
    case "redelegation": {
      if (right.kind !== "redelegation") return null;
      return {
        kind: "redelegation",
        ref: left.ref,
        maxDepth: Math.min(left.maxDepth, right.maxDepth),
        critical,
      };
    }
    case "asset": {
      if (right.kind !== "asset") return null;
      if (!assetEqual(left.asset, right.asset)) {
        return null;
      }
      return { kind: "asset", ref: left.ref, asset: left.asset, critical };
    }
  }
}
