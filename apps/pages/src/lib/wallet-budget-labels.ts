/**
 * WAL-D20 — funding cadence is not a spending ceiling.
 * UI copy helpers keep deposit/funding language distinct from enforceable caps.
 */

export type BudgetLabelKind = "funding_cadence" | "spending_ceiling";

export function budgetLabelFor(
  kind: BudgetLabelKind,
  amountDisplay: string,
): string {
  if (kind === "funding_cadence") {
    return `Funding cadence ${amountDisplay} (not a daily spending ceiling)`;
  }
  return `Spending ceiling ${amountDisplay}`;
}

export function fundingCadenceImpliesSpendingCeiling(label: string): boolean {
  const lower = label.toLowerCase();
  if (!lower.includes("funding") && !lower.includes("deposit")) return false;
  return (
    lower.includes("spending ceiling") &&
    !lower.includes("not a") &&
    !lower.includes("not an")
  );
}
