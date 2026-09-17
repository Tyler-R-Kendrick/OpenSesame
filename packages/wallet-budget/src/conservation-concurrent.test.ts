import { describe, expect, it } from "vitest";
import { createBudgetLedger } from "./ledger.js";
import { createInMemoryBudgetStore } from "./store.js";
import { conserves } from "./types.js";

describe("WAL-D03 concurrent remainder", () => {
  it("two concurrent six-unit spends against ten remaining grant at most one", async () => {
    const l = createBudgetLedger(createInMemoryBudgetStore());
    l.openNode({ nodeId: "root", ceiling: 10n, strategy: "shared_counter" });
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
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        l.reserve({ attemptId: "six-a", nodeId: "a", amount: 6n }),
      ),
      Promise.resolve().then(() =>
        l.reserve({ attemptId: "six-b", nodeId: "b", amount: 6n }),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const root = l.project("root");
    expect(root && conserves(root)).toBe(true);
    expect(root?.reservedToChildren).toBe(6n);
    expect(root?.locallyAvailable).toBe(4n);
  });
});
