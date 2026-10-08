import { expect, it } from "vitest";
import { managementOperation } from "./management-wire.js";
it("accepts only explicitly acknowledged bounded selected legacy resolution", () => {
  const operation = {
    verb: "legacy-resolve",
    connectionIds: ["selected-legacy"],
    decision: "discard",
    acknowledgeOwnershipAmbiguity: true,
  };
  expect(managementOperation.safeParse(operation).success).toBe(true);
  for (const change of [
    { acknowledgeOwnershipAmbiguity: false },
    { connectionIds: [] },
    { connectionIds: ["repeated", "repeated"] },
    { connectionIds: Array.from({ length: 17 }, (_, i) => `record-${i}`) },
    { decision: "auto-assign" },
    { password: "must-not-be-an-operation-field" },
  ])
    expect(
      managementOperation.safeParse({ ...operation, ...change }).success,
    ).toBe(false);
  expect(
    managementOperation.safeParse({
      verb: "legacy-discard-corrupt",
      acknowledgeIrrecoverableLegacyDiscard: true,
    }).success,
  ).toBe(true);
  expect(
    managementOperation.safeParse({ verb: "legacy-discard-corrupt" }).success,
  ).toBe(false);
});
