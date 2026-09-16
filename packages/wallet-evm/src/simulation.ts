/**
 * In-memory shared-ancestor spend counter.
 *
 * NOT contract verification. This models the directive invariant that sibling
 * delegates under one constrained ancestor compete for a shared ceiling. Real
 * MetaMask enforcer behavior is proven only by wallet:test:contracts once the
 * BUILD harness exists.
 */

import type { AmountUnits, Ref } from "./types.js";

export type SharedAncestorSpendResult =
  | { kind: "accepted"; spent: AmountUnits; remaining: AmountUnits }
  | {
      kind: "rejected";
      reason: "overspend" | "unknown_root" | "invalid_amount";
      spent: AmountUnits;
      remaining: AmountUnits;
      requested: AmountUnits;
    };

/**
 * Pure-TS stand-in for a shared period/transfer counter keyed by a stable
 * root accounting reference (the shared constrained ancestor).
 */
export class InMemorySharedAncestorCounter {
  readonly #ceilingByRoot = new Map<Ref, AmountUnits>();
  readonly #spentByRoot = new Map<Ref, AmountUnits>();

  openRoot(rootAccountingRef: Ref, ceiling: AmountUnits): void {
    if (ceiling < 0n) {
      throw new RangeError("ceiling must be a non-negative AmountUnits");
    }
    if (this.#ceilingByRoot.has(rootAccountingRef)) {
      throw new Error(`root already open: ${rootAccountingRef}`);
    }
    this.#ceilingByRoot.set(rootAccountingRef, ceiling);
    this.#spentByRoot.set(rootAccountingRef, 0n);
  }

  spent(rootAccountingRef: Ref): AmountUnits {
    const value = this.#spentByRoot.get(rootAccountingRef);
    if (value === undefined) {
      throw new Error(`unknown root: ${rootAccountingRef}`);
    }
    return value;
  }

  remaining(rootAccountingRef: Ref): AmountUnits {
    const ceiling = this.#ceilingByRoot.get(rootAccountingRef);
    if (ceiling === undefined) {
      throw new Error(`unknown root: ${rootAccountingRef}`);
    }
    return ceiling - this.spent(rootAccountingRef);
  }

  /**
   * Attempt to spend `amount` against the shared ancestor ceiling.
   * Sibling delegates that share `rootAccountingRef` compete here.
   */
  trySpend(
    rootAccountingRef: Ref,
    amount: AmountUnits,
  ): SharedAncestorSpendResult {
    if (amount < 0n) {
      return {
        kind: "rejected",
        reason: "invalid_amount",
        spent: 0n,
        remaining: 0n,
        requested: amount,
      };
    }
    const ceiling = this.#ceilingByRoot.get(rootAccountingRef);
    const spent = this.#spentByRoot.get(rootAccountingRef);
    if (ceiling === undefined || spent === undefined) {
      return {
        kind: "rejected",
        reason: "unknown_root",
        spent: 0n,
        remaining: 0n,
        requested: amount,
      };
    }
    const remaining = ceiling - spent;
    if (amount > remaining) {
      return {
        kind: "rejected",
        reason: "overspend",
        spent,
        remaining,
        requested: amount,
      };
    }
    const next = spent + amount;
    this.#spentByRoot.set(rootAccountingRef, next);
    return {
      kind: "accepted",
      spent: next,
      remaining: ceiling - next,
    };
  }
}
