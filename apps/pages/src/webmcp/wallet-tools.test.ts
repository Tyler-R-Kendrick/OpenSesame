/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { WALLET_TOOLS } from "./wallet-tools.js";

describe("WALLET_TOOLS", () => {
  it("exposes only read-only inventory/ledger tools (WAL-B13)", () => {
    expect(WALLET_TOOLS.every((t) => t.readOnly === true)).toBe(true);
    const names = WALLET_TOOLS.map((t) => t.name);
    expect(names).toContain("opensesame_wallet_capabilities_read");
    expect(names).toContain("opensesame_wallet_budgets_read");
    expect(names).toContain("opensesame_wallet_allocations_read");
    expect(names.some((n) => /execute|sign|secret|card|spend/i.test(n))).toBe(
      false,
    );
  });

  it("capabilities inventory refuses secret and spend verbs", () => {
    const tool = WALLET_TOOLS.find(
      (t) => t.name === "opensesame_wallet_capabilities_read",
    );
    if (tool === undefined) {
      throw new Error("missing opensesame_wallet_capabilities_read");
    }
    const result = tool.execute({});
    if (
      typeof result !== "object" ||
      result === null ||
      !("refusals" in result) ||
      !("productionEnabled" in result)
    ) {
      throw new Error("unexpected capabilities payload");
    }
    const refusals = result.refusals;
    if (!Array.isArray(refusals)) {
      throw new Error("refusals must be an array");
    }
    expect(result.productionEnabled).toBe(false);
    for (const verb of [
      "get_secret",
      "get_card_number",
      "export_private_key",
      "unrestricted_sign",
      "unbounded_paid_fetch",
    ]) {
      expect(refusals).toContain(verb);
    }
  });
});
