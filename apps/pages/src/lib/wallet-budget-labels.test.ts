import { describe, expect, it } from "vitest";
import {
  budgetLabelFor,
  fundingCadenceImpliesSpendingCeiling,
} from "./wallet-budget-labels.js";

describe("wallet budget labels (WAL-D20)", () => {
  it("keeps funding cadence distinct from spending ceiling", () => {
    const funding = budgetLabelFor("funding_cadence", "10 TEST/day");
    expect(fundingCadenceImpliesSpendingCeiling(funding)).toBe(false);
    expect(funding).toMatch(/not a daily spending ceiling/i);
    const ceiling = budgetLabelFor("spending_ceiling", "10 TEST");
    expect(ceiling).toMatch(/^Spending ceiling/);
    expect(fundingCadenceImpliesSpendingCeiling(ceiling)).toBe(false);
  });

  it("flags hostile copy that equates funding with a ceiling", () => {
    expect(
      fundingCadenceImpliesSpendingCeiling(
        "Daily funding 10 TEST is your spending ceiling",
      ),
    ).toBe(true);
  });
});
