import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { BudgetError } from "./errors.js";
import { createBudgetLedger } from "./ledger.js";
import { createInMemoryBudgetStore } from "./store.js";
import { conserves } from "./types.js";

describe("conservation identity", () => {
  it("keeps disjoint buckets summing to ceiling under shared reserves", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 500n }),
        fc.array(fc.bigInt({ min: 1n, max: 200n }), {
          minLength: 1,
          maxLength: 12,
        }),
        (ceiling, amounts) => {
          const l = createBudgetLedger(createInMemoryBudgetStore());
          l.openNode({
            nodeId: "root",
            ceiling,
            strategy: "shared_counter",
          });
          l.openNode({
            nodeId: "a",
            parentId: "root",
            ceiling: 0n,
            strategy: "shared_counter",
          });
          l.openNode({
            nodeId: "b",
            parentId: "root",
            ceiling: 0n,
            strategy: "shared_counter",
          });

          let spent = 0n;
          for (let i = 0; i < amounts.length; i += 1) {
            const amount = amounts[i];
            if (amount === undefined) continue;
            const nodeId = i % 2 === 0 ? "a" : "b";
            try {
              l.reserve({
                attemptId: `t-${i}`,
                nodeId,
                amount,
              });
              spent += amount;
            } catch (error) {
              expect(error).toBeInstanceOf(BudgetError);
            }
          }

          const root = l.project("root");
          expect(root).toBeDefined();
          if (root === undefined) return;
          expect(conserves(root)).toBe(true);
          expect(root.locallyAvailable + root.reservedToChildren).toBe(ceiling);
          expect(spent).toBeLessThanOrEqual(ceiling);
          expect(root.reservedToChildren).toBe(spent);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("never lets two sequential full-remainder reserves both succeed", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10_000n }), (remainder) => {
        const l = createBudgetLedger(createInMemoryBudgetStore());
        l.openNode({
          nodeId: "root",
          ceiling: remainder,
          strategy: "shared_counter",
        });
        l.openNode({
          nodeId: "a",
          parentId: "root",
          ceiling: 0n,
          strategy: "shared_counter",
        });
        l.openNode({
          nodeId: "b",
          parentId: "root",
          ceiling: 0n,
          strategy: "shared_counter",
        });

        const outcomes: boolean[] = [];
        for (const [attemptId, nodeId] of [
          ["r1", "a"],
          ["r2", "b"],
        ] as const) {
          try {
            l.reserve({ attemptId, nodeId, amount: remainder });
            outcomes.push(true);
          } catch (error) {
            expect(error).toBeInstanceOf(BudgetError);
            outcomes.push(false);
          }
        }

        const successes = outcomes.filter(Boolean).length;
        expect(successes).toBe(1);
        const root = l.project("root");
        expect(root).toBeDefined();
        if (root === undefined) return;
        expect(conserves(root)).toBe(true);
        expect(root.locallyAvailable).toBe(0n);
      }),
      { numRuns: 40 },
    );
  });

  it("exclusive allocations never mint authority beyond the parent ceiling", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 300n }),
        fc.array(fc.bigInt({ min: 1n, max: 150n }), {
          minLength: 1,
          maxLength: 8,
        }),
        (ceiling, slices) => {
          const l = createBudgetLedger(createInMemoryBudgetStore());
          l.openNode({
            nodeId: "root",
            ceiling,
            strategy: "exclusive_allocation",
          });

          let allocated = 0n;
          for (let i = 0; i < slices.length; i += 1) {
            const amount = slices[i];
            if (amount === undefined) continue;
            const childId = `c${i}`;
            l.openNode({
              nodeId: childId,
              parentId: "root",
              ceiling: 0n,
              strategy: "shared_counter",
            });
            try {
              l.allocateExclusive({
                parentId: "root",
                childId,
                amount,
              });
              allocated += amount;
            } catch (error) {
              expect(error).toBeInstanceOf(BudgetError);
            }
          }

          const root = l.project("root");
          expect(root).toBeDefined();
          if (root === undefined) return;
          expect(conserves(root)).toBe(true);
          expect(allocated).toBeLessThanOrEqual(ceiling);
          expect(root.reservedToChildren).toBe(allocated);
          expect(root.locallyAvailable).toBe(ceiling - allocated);
        },
      ),
      { numRuns: 40 },
    );
  });
});
