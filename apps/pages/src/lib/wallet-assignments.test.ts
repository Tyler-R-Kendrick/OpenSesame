/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignInstrumentBudget,
  budgetIdForInstrument,
  clearInstrumentBudgets,
  instrumentIdsForBudget,
  setBudgetInstruments,
  unbindBudget,
} from "./wallet-assignments.js";

function ensureLocalStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
  } satisfies Storage);
}

describe("wallet assignments", () => {
  beforeEach(() => {
    ensureLocalStorage();
    clearInstrumentBudgets();
  });
  afterEach(() => {
    clearInstrumentBudgets();
  });

  it("binds a vault item to a budget and lists both directions", () => {
    assignInstrumentBudget("itm_card", "b-1");
    expect(budgetIdForInstrument("itm_card")).toBe("b-1");
    expect(instrumentIdsForBudget("b-1")).toEqual(["itm_card"]);
    setBudgetInstruments("b-1", ["itm_card", "itm_bank"]);
    expect(instrumentIdsForBudget("b-1")).toEqual(["itm_card", "itm_bank"]);
    unbindBudget("b-1");
    expect(budgetIdForInstrument("itm_card")).toBeNull();
  });
});
