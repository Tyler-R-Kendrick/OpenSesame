import { describe, expect, it } from "vitest";

import { BudgetError } from "./errors.js";
import { createBudgetLedger } from "./ledger.js";
import { createInMemoryBudgetStore } from "./store.js";
import { type BudgetProjection, conserves } from "./types.js";

function ledger() {
  return createBudgetLedger(createInMemoryBudgetStore());
}

function expectConserves(p: BudgetProjection | undefined): BudgetProjection {
  expect(p).toBeDefined();
  if (p === undefined) {
    throw new Error("expected projection");
  }
  expect(conserves(p)).toBe(true);
  return p;
}

describe("budget ledger — exclusive allocation", () => {
  it("opens a root and allocates exclusive slices to children", () => {
    const l = ledger();
    l.openNode({
      nodeId: "root",
      ceiling: 100n,
      strategy: "exclusive_allocation",
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

    const { parent, child } = l.allocateExclusive({
      parentId: "root",
      childId: "a",
      amount: 40n,
    });
    expect(parent.locallyAvailable).toBe(60n);
    expect(parent.reservedToChildren).toBe(40n);
    expect(child.locallyAvailable).toBe(40n);
    expectConserves(parent);
    expectConserves(child);

    l.allocateExclusive({ parentId: "root", childId: "b", amount: 60n });
    expect(() =>
      l.allocateExclusive({ parentId: "root", childId: "a", amount: 1n }),
    ).toThrow(BudgetError);
  });

  it("reserves, commits, and releases against an exclusive child", () => {
    const l = ledger();
    l.transact((tx) => {
      tx.openNode({
        nodeId: "root",
        ceiling: 50n,
        strategy: "exclusive_allocation",
      });
      tx.openNode({
        nodeId: "child",
        parentId: "root",
        ceiling: 0n,
        strategy: "shared_counter",
      });
      tx.allocateExclusive({
        parentId: "root",
        childId: "child",
        amount: 50n,
      });
    });

    l.reserve({ attemptId: "pay-1", nodeId: "child", amount: 20n });
    let child = expectConserves(l.project("child"));
    expect(child.unresolvedExternalExposure).toBe(20n);
    expect(child.locallyAvailable).toBe(30n);

    l.commit("pay-1");
    child = expectConserves(l.project("child"));
    expect(child.postedSpending).toBe(20n);
    expect(child.unresolvedExternalExposure).toBe(0n);

    l.reserve({ attemptId: "pay-2", nodeId: "child", amount: 10n });
    l.release("pay-2");
    child = expectConserves(l.project("child"));
    expect(child.locallyAvailable).toBe(30n);
    expect(child.unresolvedExternalExposure).toBe(0n);
  });
});

describe("budget ledger — shared counter", () => {
  it("lets sibling children compete for the parent remainder", () => {
    const l = ledger();
    l.openNode({
      nodeId: "root",
      ceiling: 100n,
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

    l.reserve({ attemptId: "a1", nodeId: "a", amount: 70n });
    expect(() =>
      l.reserve({ attemptId: "b1", nodeId: "b", amount: 40n }),
    ).toThrow(BudgetError);

    l.reserve({ attemptId: "b1", nodeId: "b", amount: 30n });
    const root = expectConserves(l.project("root"));
    expect(root.locallyAvailable).toBe(0n);
    expect(root.reservedToChildren).toBe(100n);
  });

  it("is idempotent on logical payment attempt id", () => {
    const l = ledger();
    l.openNode({
      nodeId: "root",
      ceiling: 25n,
      strategy: "shared_counter",
    });
    l.openNode({
      nodeId: "child",
      parentId: "root",
      ceiling: 0n,
      strategy: "shared_counter",
    });

    const first = l.reserve({
      attemptId: "same",
      nodeId: "child",
      amount: 10n,
    });
    const second = l.reserve({
      attemptId: "same",
      nodeId: "child",
      amount: 10n,
    });
    expect(second).toEqual(first);
    expect(expectConserves(l.project("root")).locallyAvailable).toBe(15n);

    expect(() =>
      l.reserve({ attemptId: "same", nodeId: "child", amount: 5n }),
    ).toThrow(BudgetError);
  });

  it("rolls back a failed transaction without publishing holds", () => {
    const store = createInMemoryBudgetStore();
    const l = createBudgetLedger(store);
    l.openNode({
      nodeId: "root",
      ceiling: 10n,
      strategy: "shared_counter",
    });

    expect(() =>
      l.transact((tx) => {
        tx.reserve({ attemptId: "x", nodeId: "root", amount: 4n });
        tx.reserve({ attemptId: "y", nodeId: "root", amount: 8n });
      }),
    ).toThrow(BudgetError);

    expect(expectConserves(l.project("root")).locallyAvailable).toBe(10n);
    expect(l.projectAttempt("x")).toBeUndefined();
  });

  it("keeps exposure when a fresh instrument id is used (WAL-D10)", () => {
    const l = ledger();
    l.openNode({
      nodeId: "root",
      ceiling: 1000n,
      strategy: "shared_counter",
    });
    l.reserve({ attemptId: "pass-v1", nodeId: "root", amount: 400n });
    l.commit("pass-v1");
    // New temporary instrument / key id must not mint a fresh ceiling.
    expect(() =>
      l.reserve({
        attemptId: "pass-v2-rotated-key",
        nodeId: "root",
        amount: 700n,
      }),
    ).toThrow();
    const root = l.project("root");
    expect(root?.postedSpending).toBe(400n);
    expect(root?.locallyAvailable).toBe(600n);
  });
});

describe("budget ledger — close and ceiling", () => {
  it("raises a root ceiling and refuses a cut below posted spend", () => {
    const l = ledger();
    l.openNode({
      nodeId: "root",
      ceiling: 100n,
      strategy: "shared_counter",
    });
    l.reserve({ attemptId: "p", nodeId: "root", amount: 40n });
    l.commit("p");
    expect(
      l.setCeiling({ nodeId: "root", ceiling: 150n }).locallyAvailable,
    ).toBe(110n);
    expect(() => l.setCeiling({ nodeId: "root", ceiling: 30n })).toThrow(
      BudgetError,
    );
  });

  it("closes an idle root and refuses a reserved one", () => {
    const l = ledger();
    l.openNode({
      nodeId: "root",
      ceiling: 50n,
      strategy: "shared_counter",
    });
    l.reserve({ attemptId: "hold", nodeId: "root", amount: 10n });
    expect(() => l.closeNode("root")).toThrow(BudgetError);
    l.release("hold");
    l.closeNode("root");
    expect(l.project("root")).toBeUndefined();
  });

  it("returns unused exclusive carve-out to the parent on close", () => {
    const l = ledger();
    l.openNode({
      nodeId: "root",
      ceiling: 100n,
      strategy: "exclusive_allocation",
    });
    l.openNode({
      nodeId: "child",
      parentId: "root",
      ceiling: 0n,
      strategy: "shared_counter",
    });
    l.allocateExclusive({ parentId: "root", childId: "child", amount: 40n });
    l.reserve({ attemptId: "p", nodeId: "child", amount: 10n });
    l.commit("p");
    l.closeNode("child");
    const root = expectConserves(l.project("root"));
    expect(root.locallyAvailable).toBe(90n);
    expect(root.postedSpending).toBe(10n);
    expect(root.reservedToChildren).toBe(0n);
    expect(l.project("child")).toBeUndefined();
  });

  it("returns shared-child committed spend to the parent on close", () => {
    const l = ledger();
    l.openNode({
      nodeId: "root",
      ceiling: 100n,
      strategy: "shared_counter",
    });
    l.openNode({
      nodeId: "child",
      parentId: "root",
      ceiling: 0n,
      strategy: "shared_counter",
    });
    l.reserve({ attemptId: "p", nodeId: "child", amount: 25n });
    l.commit("p");
    l.closeNode("child");
    const root = expectConserves(l.project("root"));
    expect(root.postedSpending).toBe(25n);
    expect(root.reservedToChildren).toBe(0n);
    expect(root.locallyAvailable).toBe(75n);
    expect(l.project("child")).toBeUndefined();
  });

  it("refuses to close a root with posted spend", () => {
    const l = ledger();
    l.openNode({
      nodeId: "root",
      ceiling: 50n,
      strategy: "shared_counter",
    });
    l.reserve({ attemptId: "p", nodeId: "root", amount: 10n });
    l.commit("p");
    expect(() => l.closeNode("root")).toThrow(BudgetError);
  });
});
